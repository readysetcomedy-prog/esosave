/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'safari',
  name: 'ESOSaveExtension',
  displayName: 'ESO Save',
  bundleIdentifier: '.extension',
  deploymentTarget: '15.1',
  // The app writes scanned pages into this shared container; the extension reads them from here.
  entitlements: {
    'com.apple.security.application-groups': ['group.com.ruralmedems.esosave'],
  },
  frameworks: ['Vision'],
});
