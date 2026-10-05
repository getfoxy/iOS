// make-intro.swift — the launch intro, from the source animation to what ships.
//
//     swift tools/make-intro.swift "<the mp4>"
//
// The drawing arrives white on black already (1168x768, 24fps, 9.6s), which is
// how Foxy shows it, so nothing here touches colour: this scales it down and
// re-encodes it at a size a phone needs, and pulls out the last frame for the
// page to freeze on.
//
// Every frame is composited onto the splash's own canvas — a phone-shaped
// 600x1304, the fox at the size and place the splash has it — so the video and
// the still are the same picture and the page lays both out with the same rule
// (cover, centred). The first attempt sized and offset the video against the
// splash with CSS arithmetic instead, and it sat thirty points low on the
// phone: two different layout rules for two pictures that have to line up
// exactly is a bug waiting for a device to show it.
//
// The still the splash shows is written here too, from the first frame, so it
// cannot drift from the animation.
//
// An earlier version took the animated GIF and turned it inside out (the art
// was line work on white then), flood-filling the ground to black frame by
// frame. It flickered: a GIF frame that only carries what changed leaves the
// fill nothing closed to work with, and that frame came out solid. The mp4 has
// whole frames and needs none of it.
import Foundation
import AVFoundation
import ImageIO
import CoreGraphics
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count > 1 else {
    FileHandle.standardError.write("usage: swift tools/make-intro.swift <mp4>\n".data(using: .utf8)!)
    exit(2)
}
/* The canvas everything is drawn on: the splash's shape (1321 x 2869) at a
 * size a phone can use. Even numbers, which the encoder wants. */
let OUT_W = 600, OUT_H = 1304

/* Where the fox goes on it, as fractions of the canvas — read off the splash
 * as composed: 20.21% to 79.56% across, its top at 44.68% down. The
 * drawing's own fox sits at 14.12%…81.37% across its frame with its top at
 * 23.38%, so a frame is scaled and placed to put one on the other. */
/* FOX_TOP is tuned against the splash rather than derived: the placement below
 * reads as top-down but lands bottom-referenced, and rather than leave a
 * derivation that is wrong in a way that happens to cancel, this is the value
 * that measures right. Two runs pinned the relation (0.4468 → 0.4110 measured,
 * 0.4826 → 0.3758), and the composited still is measured against the splash
 * every time this is changed. */
let FOX_X0 = 0.2021, FOX_X1 = 0.7956, FOX_TOP = 0.4110
let ART_X0 = 0.1412, ART_X1 = 0.8137, ART_TOP = 0.2338

func composited(_ img: CGImage) -> CGImage {
    let ctx = CGContext(data: nil, width: OUT_W, height: OUT_H, bitsPerComponent: 8, bytesPerRow: 0,
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: OUT_W, height: OUT_H))
    let w = Double(OUT_W) * (FOX_X1 - FOX_X0) / (ART_X1 - ART_X0)
    let h = w * Double(img.height) / Double(img.width)
    let x = Double(OUT_W) * FOX_X0 - ART_X0 * w
    let topDown = Double(OUT_H) * FOX_TOP - ART_TOP * h
    ctx.draw(img, in: CGRect(x: x, y: Double(OUT_H) - topDown - h, width: w, height: h))
    return ctx.makeImage()!
}

/// Where the drawing is inside the frame, as fractions of it, measured from the
/// top left. Anything that is not near-black counts as the fox.
func foxBox(_ img: CGImage) -> (x0: Double, y0: Double, x1: Double, y1: Double) {
    let w = img.width, h = img.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    px.withUnsafeMutableBytes { buf in
        let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8,
                            bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    var x0 = w, x1 = -1, y0 = h, y1 = -1
    for row in 0..<h {
        for col in 0..<w {
            let o = (row * w + col) * 4
            if Int(px[o]) + Int(px[o + 1]) + Int(px[o + 2]) < 180 { continue }   // ground
            if col < x0 { x0 = col }; if col > x1 { x1 = col }
            if row < y0 { y0 = row }; if row > y1 { y1 = row }
        }
    }
    guard x1 >= x0 else { return (0, 0, 1, 1) }
    // CGContext rows run bottom-up; report in top-left terms
    return (Double(x0) / Double(w), Double(h - 1 - y1) / Double(h),
            Double(x1) / Double(w), Double(h - 1 - y0) / Double(h))
}

func writePNG(_ img: CGImage, _ path: String) {
    let d = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL,
                                            UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(d, img, nil)
    CGImageDestinationFinalize(d)
}

let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
guard let track = asset.tracks(withMediaType: .video).first else {
    FileHandle.standardError.write("no video track in that file\n".data(using: .utf8)!); exit(1)
}
let reader = try! AVAssetReader(asset: asset)
let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
])
reader.add(output)
reader.startReading()

let out = URL(fileURLWithPath: "Web/foxy-intro.mp4")
try? FileManager.default.removeItem(at: out)
let writer = try! AVAssetWriter(outputURL: out, fileType: .mp4)
var input: AVAssetWriterInput?
var adaptor: AVAssetWriterInputPixelBufferAdaptor?
var size = CGSize.zero
var first: CGImage?, last: CGImage?
var count = 0

while let sample = output.copyNextSampleBuffer() {
    guard let pb = CMSampleBufferGetImageBuffer(sample) else { continue }
    let at = CMSampleBufferGetPresentationTimeStamp(sample)
    CVPixelBufferLockBaseAddress(pb, .readOnly)
    let ctx = CGContext(data: CVPixelBufferGetBaseAddress(pb),
                        width: CVPixelBufferGetWidth(pb), height: CVPixelBufferGetHeight(pb),
                        bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pb),
                        space: CGColorSpaceCreateDeviceRGB(),
                        bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                            | CGBitmapInfo.byteOrder32Little.rawValue)!
    let frame = composited(ctx.makeImage()!)
    CVPixelBufferUnlockBaseAddress(pb, .readOnly)

    if input == nil {
        size = CGSize(width: frame.width, height: frame.height)
        first = frame
        let inp = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: frame.width,
            AVVideoHeightKey: frame.height,
            // tagged rather than guessed: an untagged file came out inverted on a phone
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 2_000_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        inp.expectsMediaDataInRealTime = false
        let ad = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: inp,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: frame.width,
                kCVPixelBufferHeightKey as String: frame.height,
            ])
        writer.add(inp); writer.startWriting(); writer.startSession(atSourceTime: .zero)
        input = inp; adaptor = ad
    }
    last = frame
    var dst: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, adaptor!.pixelBufferPool!, &dst)
    let buffer = dst!
    CVPixelBufferLockBaseAddress(buffer, [])
    let into = CGContext(data: CVPixelBufferGetBaseAddress(buffer),
                         width: Int(size.width), height: Int(size.height), bitsPerComponent: 8,
                         bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                         space: CGColorSpaceCreateDeviceRGB(),
                         bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue
                             | CGBitmapInfo.byteOrder32Little.rawValue)!
    into.draw(frame, in: CGRect(origin: .zero, size: size))
    CVPixelBufferUnlockBaseAddress(buffer, [])
    while !(input!.isReadyForMoreMediaData) { usleep(2000) }
    adaptor!.append(buffer, withPresentationTime: at)
    count += 1
}
input!.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
guard writer.status == .completed else {
    FileHandle.standardError.write("the video would not write: \(writer.error?.localizedDescription ?? "?")\n".data(using: .utf8)!)
    exit(1)
}
writePNG(last!, "Web/foxy-intro-last.png")
// the splash, from the first frame, so the still and the animation cannot drift
writePNG(first!, "Web/foxy-splash-still.png")
let bytes = ((try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0) ?? 0
let f = foxBox(first!), l = foxBox(last!)
print("Web/foxy-intro.mp4  \(count) frames, \(Int(size.width))x\(Int(size.height)), \(bytes / 1024)KB")
print(String(format: "first frame fox: x %.4f…%.4f  y %.4f…%.4f", f.x0, f.x1, f.y0, f.y1))
print(String(format: "last  frame fox: x %.4f…%.4f  y %.4f…%.4f", l.x0, l.x1, l.y0, l.y1))
