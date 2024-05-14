const axios = require('axios')
const ecomUtils = require('@ecomplus/utils')
const LoggiAxios = require('../../../lib/loggi/create-access')

exports.post = async ({ appSdk }, req, res) => {
  console.log('log req', JSON.stringify(req))
  /**
   * Treat `params` and (optionally) `application` from request body to properly mount the `response`.
   * JSON Schema reference for Calculate Shipping module objects:
   * `params`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/schema.json?store_id=100
   * `response`: https://apx-mods.e-com.plus/api/v1/calculate_shipping/response_schema.json?store_id=100
   *
   * Examples in published apps:
   * https://github.com/ecomplus/app-mandabem/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-kangu/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   * https://github.com/ecomplus/app-jadlog/blob/master/functions/routes/ecom/modules/calculate-shipping.js
   */

  const { params, application } = req.body
  const { storeId } = req
  // setup basic required response object
  const response = {
    shipping_services: []
  }
  // merge all app options configured by merchant
  const appData = Object.assign({}, application.data, application.hidden_data)

  const getAddress = async (zip) => {
    console.log('zip is', JSON.stringify(zip))
    const destination = {
      "city": "Manaus",
      "province_code": "AM",
      "country":  "Brasil"
    }

    const options = {
      method: 'GET', 
      url: `https://viacep.com.br/ws/${zip}/json/`,
      timeout: 5000
    };
    try {
      const { data } = await axios.request(options);
      console.log('data form viacep', JSON.stringify(data)
      )
      if (data && data.uf && data.localidade) {
        destination.city = data.localidade
        destination.province_code = data.uf.toUpperCase()
      }
    } catch (error) {
      console.log('didnt return address', error);
    }
    console.log('destination', JSON.stringify(destination))
    return destination
  }

  let shippingRules
  if (Array.isArray(appData.shipping_rules) && appData.shipping_rules.length) {
    shippingRules = appData.shipping_rules
  } else {
    shippingRules = []
  }

  const { client_id, client_secret, company_id } = appData
  const loggiAxios = new LoggiAxios(client_id, client_secret, storeId)

  const disableShippingRules = appData.unavailable_for
  if (!client_id) {
    // must have configured kangu doc number and token
    return res.status(409).send({
      error: 'CALCULATE_AUTH_ERR',
      message: 'Token or document unset on app hidden data (merchant must configure the app)'
    })
  }


  if (appData.free_shipping_from_value >= 0) {
    response.free_shipping_from_value = appData.free_shipping_from_value
  }

  const destinationZip = params.to ? params.to.zip.replace(/\D/g, '') : ''

  const matchService = (service, name) => {
    const fields = ['service_name', 'service_code']
    for (let i = 0; i < fields.length; i++) {
      if (service[fields[i]]) {
        return service[fields[i]].trim().toUpperCase() === name.toUpperCase()
      }
    }
    return true
  }

  const checkZipCode = rule => {
    // validate rule zip range
    if (destinationZip && rule.zip_range) {
      const { min, max } = rule.zip_range
      return Boolean((!min || destinationZip >= min) && (!max || destinationZip <= max))
    }
    return true
  }

  const parseAddress = async address => {
    let newAddress = address
    console.log('before address', JSON.stringify(newAddress))
    const correios = {
    }
    if (!address.city && address.zip) {
      const addressViaCep = await getAddress(address.zip)
      newAddress = {
        ...address,
        ...addressViaCep
      }
    }
    console.log('new address', JSON.stringify(newAddress))
    ;[
      ['logradouro', 'street'],
      ['numero', 'number'],
      ['complemento', 'complement'],
      ['bairro', 'borough'],
      ['cep', 'zip'],
      ['cidade', 'city'],
      ['uf', 'province_code']
    ].forEach(item => {
      correios[item[0]] = String(newAddress[item[1]])
    })
    
    return correios
  }

  let originZip, warehouseCode, docNumber, postingDeadline
  let isWareHouse = false
  if (params.from) {
    originZip = params.from.zip
  } else if (Array.isArray(appData.warehouses) && appData.warehouses.length) {
    for (let i = 0; i < appData.warehouses.length; i++) {
      const warehouse = appData.warehouses[i]
      if (warehouse && warehouse.zip && checkZipCode(warehouse)) {
        const { code } = warehouse
        if (!code) {
          continue
        }
        if (
          params.items &&
          params.items.find(({ quantity, inventory }) => inventory && Object.keys(inventory).length && !(inventory[code] >= quantity))
        ) {
          // item not available on current warehouse
          continue
        }
        originZip = warehouse.zip
        isWareHouse = true
        if (warehouse.posting_deadline) {
          postingDeadline = warehouse.posting_deadline
        }
        if (warehouse.doc) {
          docNumber = warehouse.doc
        }
        warehouseCode = code
      }
    }
  }
  if (!originZip) {
    originZip = appData.zip
  }
  originZip = typeof originZip === 'string' ? originZip.replace(/\D/g, '') : ''

  // search for configured free shipping rule
  if (Array.isArray(appData.free_shipping_rules)) {
    for (let i = 0; i < appData.free_shipping_rules.length; i++) {
      const rule = appData.free_shipping_rules[i]
      if (rule && checkZipCode(rule)) {
        if (!rule.min_amount) {
          response.free_shipping_from_value = 0
          break
        } else if (!(response.free_shipping_from_value <= rule.min_amount)) {
          response.free_shipping_from_value = rule.min_amount
        }
      }
    }
  }

  if (!params.to) {
    // just a free shipping preview with no shipping address received
    // respond only with free shipping option
    res.send(response)
    return
  }

  /* DO THE STUFF HERE TO FILL RESPONSE OBJECT WITH SHIPPING SERVICES */

  if (!originZip) {
    // must have configured origin zip code to continue
    return res.status(409).send({
      error: 'CALCULATE_ERR',
      message: 'Zip code is unset on app hidden data (merchant must configure the app)'
    })
  }

  console.log('Before quote', storeId)

  if (params.items) {
    // calculate weight and pkg value from items list
    let nextDimensionToSum = 'length'
    const pkg = {
      dimensions: {
        width: {
          value: 0,
          unit: 'cm'
        },
        height: {
          value: 0,
          unit: 'cm'
        },
        length: {
          value: 0,
          unit: 'cm'
        }
      },
      weight: {
        value: 0,
        unit: 'g'
      }
    }

    let cartSubtotal = 0
    function convertToUnitsAndNanos(amount) {
      let units = String(Math.trunc(amount));
      let nanos = Math.round((amount - units) * 1e9);
      return { units, nanos };
    }

    function convertToDecimal(units, nanos) {
      // Ensure the sign of nanos matches the units
      if (units !== 0 && Math.sign(nanos) !== Math.sign(units)) {
          nanos = -nanos;
      }
      return units + nanos * 1e-9; // Converts nanos to a fraction and adds to units
    }

    params.items.forEach((item) => {
      const { quantity, dimensions, weight } = item
      cartSubtotal += (quantity * ecomUtils.price(item))
      if (weight && weight.value) {
        let weightValue
        switch (weight.unit) {
          case 'kg':
            weightValue = weight.value * 1000
            break
          case 'g':
            weightValue = weight.value
            break
          case 'mg':
            weightValue = weight.value / 1000000
          default:
            weightValue = weight.value
        }
        if (weightValue) {
          pkg.weight.value += (weightValue * quantity)
        }
      }

      // sum total items dimensions to calculate cubic weight
      if (dimensions) {
        for (const side in dimensions) {
          const dimension = dimensions[side]
          if (dimension && dimension.value) {
            let dimensionValue
            switch (dimension.unit) {
              case 'cm':
                dimensionValue = dimension.value
                break
              case 'm':
                dimensionValue = dimension.value * 100
                break
              case 'mm':
                dimensionValue = dimension.value / 10
              default:
                dimensionValue = dimension.value
            }
            // add/sum current side to final dimensions object
            if (dimensionValue) {
              const pkgDimension = pkg.dimensions[side]
              if (appData.use_bigger_box === true) {
                if (!pkgDimension.value || pkgDimension.value < dimensionValue) {
                  pkgDimension.value = dimensionValue
                }
              } else {
                for (let i = 0; i < quantity; i++) {
                  if (!pkgDimension.value) {
                    pkgDimension.value = dimensionValue
                  } else if (nextDimensionToSum === side) {
                    pkgDimension.value += dimensionValue
                    nextDimensionToSum = nextDimensionToSum === 'length'
                      ? 'width'
                      : nextDimensionToSum === 'width' ? 'height' : 'length'
                  } else if (pkgDimension.value < dimensionValue) {
                    pkgDimension.value = dimensionValue
                  }
                }
              }
            }
          }
        }
      }
    })

    const { units, nanos } = convertToUnitsAndNanos(cartSubtotal)
    const shipFrom = parseAddress(appData.from)
    const shipTo = await parseAddress(params.to)

    const body = {
      shipFrom,
      shipTo,
      pickupTypes: [
        "PICKUP_TYPE_MILK_RUN"
      ], 
      packages: [{
        weightG: pkg.weight.value,
        lengthCm: pkg.dimensions.length.value,
        widthCm: pkg.dimensions.height.value,
        heightCm: pkg.dimensions.width.value,
        goodsValue: {
          currencyCode: 'BRL',
          units,
          nanos
        }
      }]
    }

    // send POST request to kangu REST API
    loggiAxios.preparing
    .then(() => {
      const { axios } = loggiAxios
      console.log('> Quote: ', JSON.stringify(body), ' <<')
      // https://axios-http.com/ptbr/docs/req_config
      const validateStatus = function (status) {
        return status >= 200 && status <= 301
      }
      return axios.post(`/v1/companies/${company_id}/quotations`, body, { 
        maxRedirects: 0,
        validateStatus
      })
    })
    .then(({ data, status }) => {
      console.log('loggi result', JSON.stringify(data))
        let result
        if (typeof data === 'string') {
          try {
            result = JSON.parse(data)
          } catch (e) {
            console.log('> loggi invalid JSON response', data)
            return res.status(409).send({
              error: 'CALCULATE_INVALID_RES',
              message: data
            })
          }
        } else {
          result = data
        }

        if (result && Number(status) === 200 && Array.isArray(result)) {
          // success response
          console.log('Quote with success', storeId)
          let lowestPriceShipping
          const loggiResult = result.packagesQuotations 
            && result.packagesQuotations.length
            && result.packagesQuotations[0].quotations
          loggiResult.forEach(loggiService => {
            let disableShipping = false
            // check if service is not disabled
            if (Array.isArray(disableShippingRules) && disableShippingRules.length) {
              console.log('disable shipping')
              for (let i = 0; i < disableShippingRules.length; i++) {
                if (
                  disableShippingRules[i] && 
                  disableShippingRules[i].zip_range &&
                  checkZipCode(disableShippingRules[i]) &&
                  disableShippingRules[i].service_name
                ) {
                  console.log('inside disable shipping')
                  const unavailable = disableShippingRules[i]
                  console.log('inside disable shipping', JSON.stringify(unavailable))
                  if (
                    matchService(unavailable, loggiService.freightTypeLabel)
                  ) {
                    disableShipping = true
                  }
                }
              }
            }
            if (!disableShipping) {
              // parse to E-Com Plus shipping line object
              const serviceCode = String(loggiService.freightType)
              const price = convertToDecimal(Number(loggiService.totalAmount.units), loggiService.totalAmount.nanos)
              const postDeadline = isWareHouse && postingDeadline 
                ? postingDeadline
                : appData.posting_deadline
              // push shipping service object to response
              const shippingLine = {
                from: {
                  ...params.from,
                  ...appData.from,
                  zip: originZip
                },
                to: params.to,
                price,
                total_price: price,
                discount: 0,
                delivery_time: {
                  days: parseInt(loggiService.sloInDays, 10),
                  working_days: true
                },
                posting_deadline: {
                  days: 3,
                  ...postDeadline
                },
                package: pkg,
                custom_fields: [
                  {
                    field: 'loggi_pickup',
                    value: loggiService.pickup_type
                  }
                ],
                flags: ['loggi-ws', `loggi-${serviceCode}`.substr(0, 20)]
              }
              if (!lowestPriceShipping || lowestPriceShipping.price > price) {
                lowestPriceShipping = shippingLine
              }

              // check for default configured additional/discount price
              if (appData.additional_price) {
                if (appData.additional_price > 0) {
                  shippingLine.other_additionals = [{
                    tag: 'additional_price',
                    label: 'Adicional padrão',
                    price: appData.additional_price
                  }]
                } else {
                  // negative additional price to apply discount
                  shippingLine.discount -= appData.additional_price
                }
                // update total price
                shippingLine.total_price += appData.additional_price
              }

              // search for discount by shipping rule
              const shippingName = loggiService.transp_nome || loggiService.descricao
              if (Array.isArray(shippingRules)) {
                for (let i = 0; i < shippingRules.length; i++) {
                  const rule = shippingRules[i]
                  if (
                    rule &&
                    matchService(rule, shippingName) &&
                    checkZipCode(rule) &&
                    !(rule.min_amount > params.subtotal)
                  ) {
                    // valid shipping rule
                    if (rule.discount && rule.service_name) {
                      let discountValue = rule.discount.value
                      if (rule.discount.percentage) {
                        discountValue *= (shippingLine.total_price / 100)
                      }
                      shippingLine.discount += discountValue
                      shippingLine.total_price -= discountValue
                      if (shippingLine.total_price < 0) {
                        shippingLine.total_price = 0
                      }
                      break
                    }
                  }
                }
              }

              // change label
              let label = shippingName
              if (appData.services && Array.isArray(appData.services) && appData.services.length) {
                const service = appData.services.find(service => {
                  return service && matchService(service, label)
                })
                if (service && service.label) {
                  label = service.label
                }
              }

              const serviceCodeName = shippingName.replaceAll(' ', '_').toLowerCase()

              response.shipping_services.push({
                label,
                carrier: loggiService.transp_nome,
                carrier_doc_number: isWareHouse && docNumber
                ? docNumber
                : typeof loggiService.cnpjTransp === 'string'
                  ? loggiService.cnpjTransp.replace(/\D/g, '').substr(0, 19)
                  : undefined,
                service_name: serviceCode || loggiService.descricao,
                service_code: serviceCodeName.substring(0, 70),
                shipping_line: shippingLine
              })
            }
          })

          if (lowestPriceShipping) {
            const { price } = lowestPriceShipping
            const discount = typeof response.free_shipping_from_value === 'number' &&
              response.free_shipping_from_value <= cartSubtotal
              ? price
              : 0
            if (discount) {
              lowestPriceShipping.total_price = price - discount
              lowestPriceShipping.discount = discount
            }
          }
          res.send(response)
        } else {
          // console.log(data)
          const err = new Error('Invalid Loggi calculate response', storeId, JSON.stringify(body))
          err.response = { data, status }
          throw err
        }
      })
      .catch(err => {
        let { message, response } = err
        console.log('>> Loggi message error', message)
        console.log('>> Loggi response error', response)

        if (response && response.data) {
          // try to handle Loggi error response
          const { data } = response
          let result
          if (typeof data === 'string') {
            try {
              result = JSON.parse(data)
            } catch (e) {
            }
          } else {
            result = data
          }
          if (result && result.data) {
            // loggi error message
            return res.status(409).send({
              error: 'CALCULATE_FAILED',
              message: result.data
            })
          }
          message = `${message} (${response.status})`
        } else {
          console.error(err)
        }
        console.log('error', err)
        return res.status(409).send({
          error: 'CALCULATE_ERR',
          message
        })
      })
  } else {
    res.status(400).send({
      error: 'CALCULATE_EMPTY_CART',
      message: 'Cannot calculate shipping without cart items'
    })
  }

  res.send(response)
}
