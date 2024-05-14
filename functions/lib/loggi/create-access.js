const createAxios = require('./create-axios')
const auth = require('./create-auth')
const { Timestamp } = require('firebase-admin/firestore')

const firestoreColl = 'loggi_tokens'

module.exports = async function (clientId, clientSecret, storeId) {
  let docRef
  if (firestoreColl) {
    docRef = require('firebase-admin')
      .firestore()
      .doc(`${firestoreColl}/${storeId}`)
  }
  const docSnapshot = await docRef.get()
  let accessToken
  const now = Timestamp.now()
  if (docSnapshot.exists) {
    const {
      idToken,
      expiredAt
    } = docSnapshot.data()

    if (now.toMillis() + 9000 < expiredAt.toMillis()) {
      accessToken = idToken
    } else {
      try {
        const data = await auth(clientId, clientSecret, storeId)
        docRef.set({
          ...data,
          updatedAt: now,
          expiredAt: Timestamp.fromMillis(now.toMillis() + ((data.expiresIn - 3600) * 1000))
        }, { merge: true })
        accessToken = data.idToken
      } catch (err) {
        console.log('Cant refresh Loggi OAtuh token', {
          url: err.config.url,
          body: err.config.data,
          response: err.response.data,
          status: err.response.status
        })
        throw err
      }
    }
  } else {
    auth(clientId, clientSecret, storeId)
      .then((data) => {
        console.log('> Loggi token => ', data)
        accessToken = data.idToken
        if (docRef) {
          docRef.set({
            ...data,
            updatedAt: now,
            expiredAt: Timestamp.fromMillis(now.toMillis() + ((data.expiresIn - 3600) * 1000))
          }).catch(console.error)
        }
      })
      .catch(err => console.log(err))
  }

  return createAxios(accessToken)
}
