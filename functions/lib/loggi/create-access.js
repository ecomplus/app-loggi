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
  if (docSnapshot.exists) {
    const {
      idToken,
      expiredAt
    } = docSnapshot.data()

    const now = Timestamp.now()
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
    throw Error('No Loggi token document')
  }

  return createAxios(accessToken)
}
