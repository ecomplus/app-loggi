module.exports = (client_id, client_secret, storeId) => new Promise((resolve, reject) => {
  const axios = require('./create-axios')(null)
  const request = isRetry => {
    console.log(`>> Create Auth s:${storeId}`)
    axios.post('/oauth2/token', {
      client_id,
      client_secret
    })
      .then(({ data }) => resolve(data))
      .catch(err => {
        console.log('>> Authentication failed', JSON.stringify(err))
        // console.log('Deu erro quero response status', err.response.status)
        if (!isRetry && err.response && err.response.status >= 429) {
          setTimeout(() => request(true), 7000)
        }
        reject(err)
      })
  }
  request()
})
