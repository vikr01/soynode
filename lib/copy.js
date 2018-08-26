

/**
 * A hacky copy method until
 * https://github.com/jprichardson/node-fs-extra/issues/326
 * is fixed.
 */

const fs = require('fs')

function copy(source, target, callback) {
  const readStream = fs.createReadStream(source)
  const writeStream = fs.createWriteStream(target)
  let isDone = false

  function onError(err) {
    if (isDone) return
    isDone = true
    callback(err)
  }
  readStream.on('error', onError)
  writeStream.on('error', onError)

  writeStream.on('open', () => {
    readStream.pipe(writeStream)
  })

  writeStream.once('close', () => {
    if (isDone) return
    isDone = true
    callback(null)
  })
}

module.exports = copy
