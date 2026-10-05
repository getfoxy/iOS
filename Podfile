platform :ios, '17.0'
project 'Foxy.xcodeproj'
target 'Foxy' do
  use_frameworks!
  # Tor.framework 409.11.2's Objective-C wrapper, with Tor itself built here from
  # signed sources: bash tools/build-tor.sh, then pod install (Vendor/README.md)
  pod 'Tor', :path => 'Vendor/TorPod'

  # The Swift unit tests (tools/unit-tests.sh) run inside Foxy.app and link
  # nothing of their own; importing Foxy's module needs Tor's module on the path.
  target 'FoxyTests' do
    inherit! :search_paths
  end
end

# The Tor pod builds Tor.framework and links Tor's own C library, which ships
# as tor.framework, with -framework "tor". This disk ignores case, and the
# pod's search path lists its own build products (and Xcode's eager-linking
# stubs) before the folder holding tor.framework. So once Tor.framework has
# been built once, "tor" finds it, and the linker refuses to link Tor with
# itself: the first build of a clean folder works and every relink after it
# fails. Name the library by its path instead of searching for it.
post_install do |installer|
  installer.pods_project.targets.each do |target|
    next unless target.name == 'Tor'
    target.build_configurations.each do |config|
      path = config.base_configuration_reference.real_path
      text = File.read(path)
      fixed = text.gsub('-framework "tor"', '"${PODS_XCFRAMEWORKS_BUILD_DIR}/Tor/CTor/tor.framework/tor"')
      File.write(path, fixed) unless fixed == text
    end
  end
end
