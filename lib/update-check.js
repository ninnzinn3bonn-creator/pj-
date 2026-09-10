'use strict';
const REPOSITORY = 'ninnzinn3bonn-creator/pj-';
function versionParts(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  return match ? match.slice(1).map(Number) : null;
}
function compareVersions(left, right) {
  const a = versionParts(left); const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}
function releaseStatus(currentVersion, release) {
  const tag = String(release?.tag_name || '');
  const asset = Array.isArray(release?.assets) ? release.assets.find(item => /^local-project-manager-v?\d+\.\d+\.\d+\.zip$/i.test(item.name || '')) : null;
  if (!versionParts(tag) || !asset?.browser_download_url) return { available: false, currentVersion };
  return { available: compareVersions(tag, currentVersion) > 0, currentVersion, latestVersion: tag.replace(/^v/i, ''), releaseUrl: String(release.html_url || ''), downloadUrl: String(asset.browser_download_url), digest: String(asset.digest || ''), notes: String(release.body || '').slice(0, 4000), publishedAt: String(release.published_at || '') };
}
module.exports = { REPOSITORY, compareVersions, releaseStatus };
