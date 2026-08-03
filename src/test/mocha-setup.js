// Redirect require('vscode') to our stub during unit tests (no extension host).
const Module = require('module');
const path = require('path');
const stubPath = path.join(__dirname, 'vscode-stub.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') { return stubPath; }
  return origResolve.call(this, request, ...rest);
};
