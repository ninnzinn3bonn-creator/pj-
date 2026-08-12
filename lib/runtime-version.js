'use strict';

const SUPPORTED_NODE_MAJORS = new Set([22, 24]);

function assertSupportedNodeVersion(version = process.versions.node) {
  const major = Number.parseInt(String(version).split('.')[0], 10);
  if (!SUPPORTED_NODE_MAJORS.has(major)) {
    throw new Error(`Node.js 22または24が必要です。現在のバージョン: ${version}`);
  }
}

module.exports = { assertSupportedNodeVersion, SUPPORTED_NODE_MAJORS };
