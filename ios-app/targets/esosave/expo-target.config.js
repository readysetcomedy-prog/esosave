/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'safari',
  name: 'ESOSaveExtension',
  displayName: 'ESO Save',
  bundleIdentifier: '.extension',
  deploymentTarget: '15.1',
});
