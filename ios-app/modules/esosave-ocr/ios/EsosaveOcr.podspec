Pod::Spec.new do |s|
  s.name           = 'EsosaveOcr'
  s.version        = '1.0.0'
  s.summary        = 'Text recognition for scanned paperwork (Apple Vision), for the ESO Save app'
  s.description    = 'Reads the text on a scanned page the way the ESO Save Safari extension reads it, so the app can show what a facesheet scan found before the crew goes back to ESO.'
  s.author         = 'RuralMed EMS'
  s.homepage       = 'https://github.com/readysetcomedy-prog/esosave'
  s.license        = { :type => 'Proprietary' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Vision', 'UIKit'
  s.source_files = '**/*.{h,m,swift}'
end
