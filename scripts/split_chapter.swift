import AppKit
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Config {
    let inputDir: URL
    let outputDir: URL
    let minGap: Int
    let whiteThreshold: UInt8
    let cropLeftRatio: Double
    let cropRightRatio: Double
}

struct Segment {
    let startY: Int
    let endY: Int
}

func parseArguments() -> Config {
    let args = CommandLine.arguments

    func value(for flag: String) -> String {
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else {
            fatalError("Missing value for \(flag)")
        }
        return args[index + 1]
    }

    return Config(
        inputDir: URL(fileURLWithPath: value(for: "--input")),
        outputDir: URL(fileURLWithPath: value(for: "--output")),
        minGap: Int(value(for: "--min-gap")) ?? 120,
        whiteThreshold: UInt8(Int(value(for: "--white-threshold")) ?? 245),
        cropLeftRatio: Double(value(for: "--crop-left-ratio")) ?? 0,
        cropRightRatio: Double(value(for: "--crop-right-ratio")) ?? 0
    )
}

func loadCGImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        return nil
    }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func rgbaBuffer(for image: CGImage) -> (data: Data, bytesPerRow: Int)? {
    let width = image.width
    let height = image.height
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var data = Data(count: bytesPerRow * height)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let alphaInfo = CGImageAlphaInfo.premultipliedLast.rawValue

    let created = data.withUnsafeMutableBytes { rawBuffer -> Bool in
        guard let base = rawBuffer.baseAddress else {
            return false
        }
        guard let context = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: alphaInfo
        ) else {
            return false
        }

        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }

    return created ? (data, bytesPerRow) : nil
}

func rowInkFractions(image: CGImage, whiteThreshold: UInt8) -> [Double] {
    guard let buffer = rgbaBuffer(for: image) else {
        return []
    }

    let width = image.width
    let height = image.height
    let sampleStride = max(1, width / 180)
    let minChannel = Int(whiteThreshold)
    var fractions = Array(repeating: 0.0, count: height)

    buffer.data.withUnsafeBytes { rawBuffer in
        guard let bytes = rawBuffer.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
            return
        }

        for y in 0..<height {
            var nonWhiteCount = 0
            var samples = 0
            let row = bytes + y * buffer.bytesPerRow

            var x = 0
            while x < width {
                let offset = x * 4
                let r = Int(row[offset])
                let g = Int(row[offset + 1])
                let b = Int(row[offset + 2])
                if r < minChannel || g < minChannel || b < minChannel {
                    nonWhiteCount += 1
                }
                samples += 1
                x += sampleStride
            }

            fractions[y] = samples == 0 ? 0 : Double(nonWhiteCount) / Double(samples)
        }
    }

    return fractions
}

func detectSegments(rowFractions: [Double], minGap: Int) -> [Segment] {
    let blankThreshold = 0.012
    let minPageHeight = 700
    var boundaryRows: [Int] = [0]
    var gapStart: Int?

    for y in 0..<rowFractions.count {
        if rowFractions[y] < blankThreshold {
            if gapStart == nil {
                gapStart = y
            }
        } else if let start = gapStart {
            if y - start >= minGap {
                boundaryRows.append((start + y) / 2)
            }
            gapStart = nil
        }
    }

    if let start = gapStart, rowFractions.count - start >= minGap {
        boundaryRows.append((start + rowFractions.count) / 2)
    }

    boundaryRows.append(rowFractions.count)
    boundaryRows = Array(Set(boundaryRows)).sorted()

    var segments: [Segment] = []
    for index in 0..<(boundaryRows.count - 1) {
        let start = boundaryRows[index]
        let end = boundaryRows[index + 1]
        if end - start >= minPageHeight {
            segments.append(Segment(startY: start, endY: end))
        }
    }

    return segments
}

func writePNG(image: CGImage, to url: URL) throws {
    guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw NSError(domain: "SplitChapter", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to create image destination"])
    }
    CGImageDestinationAddImage(destination, image, nil)
    if !CGImageDestinationFinalize(destination) {
        throw NSError(domain: "SplitChapter", code: 2, userInfo: [NSLocalizedDescriptionKey: "Unable to write PNG"])
    }
}

func crop(_ image: CGImage, segment: Segment) -> CGImage? {
    let cropRect = CGRect(
        x: 0,
        y: segment.startY,
        width: image.width,
        height: segment.endY - segment.startY
    )
    return image.cropping(to: cropRect)
}

func cropHorizontally(_ image: CGImage, leftRatio: Double, rightRatio: Double) -> CGImage? {
    guard leftRatio >= 0, rightRatio >= 0, leftRatio + rightRatio < 1 else {
        return image
    }

    let leftInset = Int((Double(image.width) * leftRatio).rounded())
    let rightInset = Int((Double(image.width) * rightRatio).rounded())
    let cropWidth = image.width - leftInset - rightInset

    guard cropWidth > 0 else {
        return image
    }

    let cropRect = CGRect(x: leftInset, y: 0, width: cropWidth, height: image.height)
    return image.cropping(to: cropRect)
}

func imageFiles(in directory: URL) -> [URL] {
    let fileManager = FileManager.default
    guard let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: nil) else {
        return []
    }

    return enumerator.compactMap { item in
        guard let url = item as? URL else {
            return nil
        }
        return ["png", "jpg", "jpeg"].contains(url.pathExtension.lowercased()) ? url : nil
    }
    .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
}

let config = parseArguments()
let fileManager = FileManager.default
try fileManager.createDirectory(at: config.outputDir, withIntermediateDirectories: true)

var pageIndex = 1
for imageURL in imageFiles(in: config.inputDir) {
    guard let rawImage = loadCGImage(imageURL) else {
        fputs("Failed to load \(imageURL.path)\n", stderr)
        continue
    }

    let image = cropHorizontally(
        rawImage,
        leftRatio: config.cropLeftRatio,
        rightRatio: config.cropRightRatio
    ) ?? rawImage

    let segments = detectSegments(
        rowFractions: rowInkFractions(image: image, whiteThreshold: config.whiteThreshold),
        minGap: config.minGap
    )

    for segment in segments {
        guard let cropped = crop(image, segment: segment) else {
            continue
        }

        let filename = String(format: "page-%03d.png", pageIndex)
        let outputURL = config.outputDir.appendingPathComponent(filename)
        try writePNG(image: cropped, to: outputURL)
        pageIndex += 1
    }
}
