"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
Object.defineProperty(exports, "SoyCompiler", {
  enumerable: true,
  get: function () {
    return _SoyCompiler.default;
  }
});
exports.default = void 0;

var _SoyCompiler = _interopRequireDefault(require("./SoyCompiler"));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

// Copyright (c)2012 The Obvious Corporation

/**
 * @fileoverview Public interface exposed to users of `soynode`.
 */
// Public API.  See function declarations for JSDoc.
var _default = new _SoyCompiler.default();

exports.default = _default;