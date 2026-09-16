/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'safari',
  name: 'ESO Save Extension',
  displayName: 'ESO Save',
  bundleIdentifier: '.extension',
  deploymentTarget: '15.1',
});
