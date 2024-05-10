const axios = require('axios')

module.exports = (accessToken) => {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json'
  }
  
  const baseURL = 'https://api.loggi.com/'

  if (accessToken) {
    console.log('> token ', accessToken)
    headers.Authorization = `Bearer ${accessToken}`
  }

  return axios.create({
    baseURL,
    headers
  })
}
