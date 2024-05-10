const createAxios = require('./create-axios')
const auth = require('./create-auth')

const firestoreColl = 'loggi_tokens'
module.exports = function (clientId, clientSecret, storeId) {
  const self = this

  let documentRef
  if (firestoreColl) {
    documentRef = require('firebase-admin')
      .firestore()
      .doc(`${firestoreColl}/${storeId}`)
  }

  this.preparing = new Promise((resolve, reject) => {
    const authenticate = (token) => {
      self.axios = createAxios(token)
      resolve(self)
    }

    const handleAuth = () => {
      console.log('> Loggi Auth02 ', storeId)
      auth(clientId, clientSecret, storeId)
        .then((data) => {
          console.log('> Loggi token => ', data)
          authenticate(data.idToken)
          if (documentRef) {
            documentRef.set({
              ...data,
              updatedAt: new Date().toISOString()
            }).catch(console.error)
          }
        })
        .catch(reject)
    }

    if (documentRef) {
      documentRef.get()
        .then((documentSnapshot) => {
          if (documentSnapshot.exists &&
            Date.now() - documentSnapshot.updateTime.toDate().getTime() <= 60 * 60 * 1000 // token expires in 60 min
          ) {
            authenticate(documentSnapshot.get('idToken'))
          } else {
            handleAuth()
          }
        })
        .catch(console.error)
    } else {
      handleAuth()
    }
  })
}

