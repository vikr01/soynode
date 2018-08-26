"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.default = _default;

var _fs = _interopRequireDefault(require("fs"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 * A hacky copy method until
 * https://github.com/jprichardson/node-fs-extra/issues/326
 * is fixed.
 */
function _default(source, target, callback) {
  const readStream = _fs.default.createReadStream(source);

  const writeStream = _fs.default.createWriteStream(target);

  let isDone = false;

  function onError(err) {
    if (isDone) return;
    isDone = true;
    callback(err);
  }

  readStream.on('error', onError);
  writeStream.on('error', onError);
  writeStream.on('open', () => {
    readStream.pipe(writeStream);
  });
  writeStream.once('close', () => {
    if (isDone) return;
    isDone = true;
    callback(null);
  });
}

module.exports = exports["default"];