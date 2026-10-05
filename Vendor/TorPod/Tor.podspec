# Tor.framework 409.11.2 (iCepa, MIT), as Foxy uses it.
#
# The same Objective-C wrapper, from commit 727f628a (Tor/Classes, pinned in
# Vendor/Tor.sha256), and the same subspec layout. What differs is where Tor
# itself comes from: tor.xcframework is built here by tools/build-tor.sh from
# signed sources, not downloaded as the maintainer's prebuilt release archive.
# There is no prepare_command, so nothing is fetched when CocoaPods installs.
Pod::Spec.new do |m|
  m.name     = 'Tor'
  m.version  = '409.11.2'
  m.summary  = 'Tor.framework with Tor built by Foxy from signed sources.'
  m.homepage = 'https://github.com/iCepa/Tor.framework'
  m.license  = { :type => 'MIT', :file => 'LICENSE' }
  m.authors  = {
    'Conrad Kramer' => 'conrad@conradkramer.com',
    'Chris Ballinger' => 'chris@chatsecure.org',
    'Mike Tigas' => 'mike@tig.as',
    'Benjamin Erhart' => 'berhart@netzarchitekten.com',
  }
  m.source   = { :git => 'https://github.com/iCepa/Tor.framework.git',
                 :commit => '727f628a15dd1bd83e0e171deb0aba7ab18be09e' }

  m.ios.deployment_target = '15.0'

  m.subspec 'Core' do |s|
    s.requires_arc = true
    s.source_files = 'Tor/Classes/Core/**/*'
  end

  m.subspec 'CTor' do |s|
    s.dependency 'Tor/Core'
    s.source_files = 'Tor/Classes/CTor/**/*'
    s.vendored_frameworks = 'tor.xcframework'
    s.libraries = 'z'
    s.pod_target_xcconfig = {
      'HEADER_SEARCH_PATHS' => '$(inherited) "${PODS_TARGET_SRCROOT}/tor.xcframework/ios-arm64/tor.framework/Headers"',
    }
    s.preserve_paths = 'tor.xcframework'
  end

  m.default_subspecs = 'CTor'
end
