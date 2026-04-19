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
    let horizontalMarginPx: Int
    let maxSegmentHeight: Int
    let oversizedSplitMinGap: Int
    let tinyFragmentHeight: Int
    let tinyMergeMaxHeight: Int
    let recombineShortHeight: Int
    let disableRecombine: Bool
}

struct Segment {
    let startY: Int
    let endY: Int
    let followingGapHeight: Int?

    var height: Int {
        endY - startY
    }
}

struct GapBoundary {
    let row: Int
    let gapHeight: Int
}

func parseArguments() -> Config {
    let args = CommandLine.arguments

    func requiredValue(for flag: String) -> String {
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else {
            fatalError("Missing value for \(flag)")
        }
        return args[index + 1]
    }

    func optionalValue(for flag: String) -> String? {
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else {
            return nil
        }
        return args[index + 1]
    }

    return Config(
        inputDir: URL(fileURLWithPath: requiredValue(for: "--input")),
        outputDir: URL(fileURLWithPath: requiredValue(for: "--output")),
        minGap: Int(optionalValue(for: "--min-gap") ?? "") ?? 120,
        whiteThreshold: UInt8(Int(optionalValue(for: "--white-threshold") ?? "") ?? 245),
        cropLeftRatio: Double(optionalValue(for: "--crop-left-ratio") ?? "") ?? 0,
        cropRightRatio: Double(optionalValue(for: "--crop-right-ratio") ?? "") ?? 0,
        horizontalMarginPx: Int(optionalValue(for: "--horizontal-margin-px") ?? "") ?? 48,
        maxSegmentHeight: Int(optionalValue(for: "--max-segment-height") ?? "") ?? 3500,
        oversizedSplitMinGap: Int(optionalValue(for: "--oversized-split-min-gap") ?? "") ?? 50,
        tinyFragmentHeight: Int(optionalValue(for: "--tiny-fragment-height") ?? "") ?? 200,
        tinyMergeMaxHeight: Int(optionalValue(for: "--tiny-merge-max-height") ?? "") ?? 3300,
        recombineShortHeight: Int(optionalValue(for: "--recombine-short-height") ?? "") ?? 1500,
        disableRecombine: args.contains("--disable-recombine")
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

func detectBoundaries(
    rowFractions: [Double],
    minGap: Int,
    startY: Int = 0,
    endY: Int? = nil
) -> [GapBoundary] {
    let blankThreshold = 0.012
    var boundaries: [GapBoundary] = []
    var gapStart: Int?
    let upperBound = endY ?? rowFractions.count

    for y in startY..<upperBound {
        if rowFractions[y] < blankThreshold {
            if gapStart == nil {
                gapStart = y
            }
        } else if let start = gapStart {
            let gapHeight = y - start
            if gapHeight >= minGap {
                boundaries.append(GapBoundary(row: (start + y) / 2, gapHeight: gapHeight))
            }
            gapStart = nil
        }
    }

    if let start = gapStart {
        let gapHeight = upperBound - start
        if gapHeight >= minGap {
            boundaries.append(GapBoundary(row: (start + upperBound) / 2, gapHeight: gapHeight))
        }
    }

    return Dictionary(grouping: boundaries, by: \.row)
        .compactMap { _, group in
            group.max { lhs, rhs in lhs.gapHeight < rhs.gapHeight }
        }
        .sorted { $0.row < $1.row }
}

func buildSegments(from boundaries: [GapBoundary], totalHeight: Int, startY: Int = 0, endY: Int? = nil) -> [Segment] {
    let upperBound = endY ?? totalHeight
    var segments: [Segment] = []
    var startRow = startY
    for boundary in boundaries where boundary.row > startY && boundary.row < upperBound {
        let endRow = boundary.row
        if endRow > startRow {
            segments.append(
                Segment(
                    startY: startRow,
                    endY: endRow,
                    followingGapHeight: boundary.gapHeight
                )
            )
        }
        startRow = endRow
    }

    if upperBound > startRow {
        segments.append(
            Segment(
                startY: startRow,
                endY: upperBound,
                followingGapHeight: nil
            )
        )
    }

    return segments
}

func splitOversizedSegments(
    segments: [Segment],
    rowFractions: [Double],
    minGap: Int,
    maxSegmentHeight: Int
) -> [Segment] {
    guard minGap > 0 else {
        return segments
    }

    var pending = segments
    var changed = true

    while changed {
        changed = false
        var nextSegments: [Segment] = []

        for segment in pending {
            guard segment.height > maxSegmentHeight else {
                nextSegments.append(segment)
                continue
            }

            let boundaries = detectBoundaries(
                rowFractions: rowFractions,
                minGap: minGap,
                startY: segment.startY,
                endY: segment.endY
            )
            let splitSegments = buildSegments(
                from: boundaries,
                totalHeight: rowFractions.count,
                startY: segment.startY,
                endY: segment.endY
            )

            if splitSegments.count > 1 {
                var adjustedSegments = splitSegments
                let last = adjustedSegments.removeLast()
                adjustedSegments.append(
                    Segment(
                        startY: last.startY,
                        endY: last.endY,
                        followingGapHeight: segment.followingGapHeight
                    )
                )
                nextSegments.append(contentsOf: adjustedSegments)
                changed = true
            } else {
                nextSegments.append(segment)
            }
        }

        pending = nextSegments
    }

    return pending
}

func detectSegments(
    rowFractions: [Double],
    minGap: Int,
    maxSegmentHeight: Int,
    oversizedSplitMinGap: Int,
    tinyFragmentHeight: Int,
    tinyMergeMaxHeight: Int,
    recombineShortHeight: Int,
    disableRecombine: Bool
) -> [Segment] {
    let primaryBoundaries = detectBoundaries(rowFractions: rowFractions, minGap: minGap)
    var segments = buildSegments(from: primaryBoundaries, totalHeight: rowFractions.count)
    if oversizedSplitMinGap < minGap {
        segments = splitOversizedSegments(
            segments: segments,
            rowFractions: rowFractions,
            minGap: oversizedSplitMinGap,
            maxSegmentHeight: maxSegmentHeight
        )
    }

    guard !disableRecombine, segments.count > 1 else {
        return segments
    }

    func mergeSegments(_ left: Segment, _ right: Segment) -> Segment {
        Segment(
            startY: left.startY,
            endY: right.endY,
            followingGapHeight: right.followingGapHeight
        )
    }

    var rescued = segments
    while true {
        var mergedAny = false

        for index in 0..<rescued.count {
            let current = rescued[index]
            if current.height >= tinyFragmentHeight {
                continue
            }

            var candidates: [(score: Int, mergeLeft: Bool)] = []

            if index > 0 {
                let left = rescued[index - 1]
                let leftGap = left.followingGapHeight ?? Int.max
                let combinedHeight = left.height + leftGap + current.height
                if combinedHeight <= tinyMergeMaxHeight {
                    candidates.append((score: combinedHeight, mergeLeft: true))
                }
            }

            if index + 1 < rescued.count {
                let right = rescued[index + 1]
                let rightGap = current.followingGapHeight ?? Int.max
                let combinedHeight = current.height + rightGap + right.height
                if combinedHeight <= tinyMergeMaxHeight {
                    candidates.append((score: combinedHeight, mergeLeft: false))
                }
            }

            guard let chosen = candidates.min(by: { lhs, rhs in
                if lhs.score == rhs.score {
                    return lhs.mergeLeft && !rhs.mergeLeft
                }
                return lhs.score < rhs.score
            }) else {
                continue
            }

            if chosen.mergeLeft {
                rescued[index - 1] = mergeSegments(rescued[index - 1], current)
                rescued.remove(at: index)
            } else {
                rescued[index] = mergeSegments(current, rescued[index + 1])
                rescued.remove(at: index + 1)
            }

            mergedAny = true
            break
        }

        if !mergedAny {
            break
        }
    }

    var recombined: [Segment] = []
    var current = rescued[0]

    for next in rescued.dropFirst() {
        let gapHeight = current.followingGapHeight ?? Int.max
        let combinedHeight = current.height + gapHeight + next.height
        let shouldMerge =
            combinedHeight <= maxSegmentHeight &&
            (current.height < recombineShortHeight || next.height < recombineShortHeight)

        if shouldMerge {
            current = Segment(
                startY: current.startY,
                endY: next.endY,
                followingGapHeight: next.followingGapHeight
            )
            continue
        }

        recombined.append(current)
        current = next
    }

    recombined.append(current)
    return recombined
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

func cropHorizontally(_ image: CGImage, leftRatio: Double, rightRatio: Double, marginPx: Int) -> CGImage? {
    guard leftRatio >= 0, rightRatio >= 0, leftRatio + rightRatio < 1 else {
        return image
    }

    let leftInset = max(0, Int((Double(image.width) * leftRatio).rounded()) - marginPx)
    let rightInset = max(0, Int((Double(image.width) * rightRatio).rounded()) - marginPx)
    let cropWidth = image.width - leftInset - rightInset

    guard cropWidth > 0 else {
        return image
    }

    let cropRect = CGRect(x: leftInset, y: 0, width: cropWidth, height: image.height)
    return image.cropping(to: cropRect)
}

func stitchImages(_ images: [CGImage]) -> CGImage? {
    guard !images.isEmpty else {
        return nil
    }

    let width = images.map(\.width).max() ?? 0
    let height = images.reduce(0) { $0 + $1.height }
    guard width > 0, height > 0 else {
        return nil
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let alphaInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: colorSpace,
        bitmapInfo: alphaInfo
    ) else {
        return nil
    }

    context.setFillColor(NSColor.white.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))

    var yOffset = height
    for image in images {
        // Left-align cropped parts to preserve each part's local x-geometry.
        yOffset -= image.height
        let rect = CGRect(x: 0, y: yOffset, width: image.width, height: image.height)
        context.draw(image, in: rect)
    }

    return context.makeImage()
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

let croppedImages = imageFiles(in: config.inputDir).compactMap { imageURL -> CGImage? in
    guard let rawImage = loadCGImage(imageURL) else {
        fputs("Failed to load \(imageURL.path)\n", stderr)
        return nil
    }

    return cropHorizontally(
        rawImage,
        leftRatio: config.cropLeftRatio,
        rightRatio: config.cropRightRatio,
        marginPx: config.horizontalMarginPx
    ) ?? rawImage
}

guard let stitchedImage = stitchImages(croppedImages) else {
    throw NSError(
        domain: "SplitChapter",
        code: 3,
        userInfo: [NSLocalizedDescriptionKey: "Unable to build stitched chapter image"]
    )
}

let segments = detectSegments(
    rowFractions: rowInkFractions(image: stitchedImage, whiteThreshold: config.whiteThreshold),
    minGap: config.minGap,
    maxSegmentHeight: config.maxSegmentHeight,
    oversizedSplitMinGap: config.oversizedSplitMinGap,
    tinyFragmentHeight: config.tinyFragmentHeight,
    tinyMergeMaxHeight: config.tinyMergeMaxHeight,
    recombineShortHeight: config.recombineShortHeight,
    disableRecombine: config.disableRecombine
)

for (index, segment) in segments.enumerated() {
    guard let cropped = crop(stitchedImage, segment: segment) else {
        continue
    }

    let filename = String(format: "page-%03d.png", index + 1)
    let outputURL = config.outputDir.appendingPathComponent(filename)
    try writePNG(image: cropped, to: outputURL)
}
