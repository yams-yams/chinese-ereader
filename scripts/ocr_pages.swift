import Foundation
import ImageIO
import NaturalLanguage
import UniformTypeIdentifiers
import Vision

struct Config {
    let inputDir: URL
    let outputDir: URL
}

struct Rect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct CharacterAnnotation: Codable {
    let id: String
    let text: String
    let box: Rect
    let wordId: String?
    let sentenceId: String?
}

struct WordAnnotation: Codable {
    let id: String
    let text: String
    let pinyin: String
    let translation: String?
    let characterIds: [String]
}

struct SentenceAnnotation: Codable {
    let id: String
    let text: String
    let pinyin: String
    let translation: String?
    let characterIds: [String]
}

struct PageAnnotation: Codable {
    let sourceImage: String
    let characters: [CharacterAnnotation]
    let words: [WordAnnotation]
    let sentences: [SentenceAnnotation]
}

func emptyAnnotation(for url: URL) -> PageAnnotation {
    PageAnnotation(
        sourceImage: url.lastPathComponent,
        characters: [],
        words: [],
        sentences: []
    )
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
        outputDir: URL(fileURLWithPath: value(for: "--output"))
    )
}

func imageURLs(in directory: URL) -> [URL] {
    let fileManager = FileManager.default
    guard let enumerator = fileManager.enumerator(at: directory, includingPropertiesForKeys: nil) else {
        return []
    }

    return enumerator.compactMap { item in
        guard let url = item as? URL else {
            return nil
        }
        return url.pathExtension.lowercased() == "png" ? url : nil
    }
    .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
}

func loadCGImage(_ url: URL) -> CGImage? {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
        return nil
    }
    return CGImageSourceCreateImageAtIndex(source, 0, nil)
}

func pinyin(for text: String) -> String {
    let mutable = NSMutableString(string: text) as CFMutableString
    CFStringTransform(mutable, nil, kCFStringTransformMandarinLatin, false)
    CFStringTransform(mutable, nil, kCFStringTransformStripCombiningMarks, false)
    return mutable as String
}

func sentenceRanges(for text: String) -> [Range<String.Index>] {
    let tokenizer = NLTokenizer(unit: .sentence)
    tokenizer.string = text
    var ranges: [Range<String.Index>] = []
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
        ranges.append(range)
        return true
    }

    if ranges.isEmpty, !text.isEmpty {
        ranges = [text.startIndex..<text.endIndex]
    }

    return ranges
}

func wordRanges(for text: String) -> [Range<String.Index>] {
    let tokenizer = NLTokenizer(unit: .word)
    tokenizer.setLanguage(.simplifiedChinese)
    tokenizer.string = text
    var ranges: [Range<String.Index>] = []
    tokenizer.enumerateTokens(in: text.startIndex..<text.endIndex) { range, _ in
        let token = String(text[range]).trimmingCharacters(in: .whitespacesAndNewlines)
        if !token.isEmpty {
            ranges.append(range)
        }
        return true
    }

    if ranges.isEmpty, !text.isEmpty {
        ranges = [text.startIndex..<text.endIndex]
    }

    return ranges
}

func recognizePage(at url: URL) throws -> PageAnnotation {
    guard let image = loadCGImage(url) else {
        throw NSError(domain: "OCRPages", code: 1, userInfo: [NSLocalizedDescriptionKey: "Unable to load image"])
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])

    let observations = (request.results ?? []).sorted {
        let a = $0.boundingBox
        let b = $1.boundingBox
        if abs(a.midY - b.midY) > 0.02 {
            return a.midY > b.midY
        }
        return a.minX < b.minX
    }

    var characters: [CharacterAnnotation] = []
    var words: [WordAnnotation] = []
    var sentences: [SentenceAnnotation] = []

    var characterCounter = 1
    var wordCounter = 1
    var sentenceCounter = 1

    for observation in observations {
        guard let candidate = observation.topCandidates(1).first else {
            continue
        }

        let lineText = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if lineText.isEmpty {
            continue
        }

        let chars = Array(lineText)
        var charIdsByOffset: [Int: String] = [:]

        for offset in chars.indices {
            let id = String(format: "char-%04d", characterCounter)
            characterCounter += 1
            let start = lineText.index(lineText.startIndex, offsetBy: offset)
            let end = lineText.index(after: start)
            let range = start..<end
            let boxObservation = try? candidate.boundingBox(for: range)
            let box = boxObservation?.boundingBox ?? observation.boundingBox

            characters.append(
                CharacterAnnotation(
                    id: id,
                    text: String(chars[offset]),
                    box: Rect(x: box.minX, y: box.minY, width: box.width, height: box.height),
                    wordId: nil,
                    sentenceId: nil
                )
            )
            charIdsByOffset[offset] = id
        }

        for range in wordRanges(for: lineText) {
            let start = lineText.distance(from: lineText.startIndex, to: range.lowerBound)
            let end = lineText.distance(from: lineText.startIndex, to: range.upperBound)
            let token = String(lineText[range])
            let charIds = (start..<end).compactMap { charIdsByOffset[$0] }
            let wordId = String(format: "word-%04d", wordCounter)
            wordCounter += 1

            words.append(
                WordAnnotation(
                    id: wordId,
                    text: token,
                    pinyin: pinyin(for: token),
                    translation: nil,
                    characterIds: charIds
                )
            )

            for characterId in charIds {
                if let index = characters.firstIndex(where: { $0.id == characterId }) {
                    characters[index] = CharacterAnnotation(
                        id: characters[index].id,
                        text: characters[index].text,
                        box: characters[index].box,
                        wordId: wordId,
                        sentenceId: characters[index].sentenceId
                    )
                }
            }
        }

        for range in sentenceRanges(for: lineText) {
            let start = lineText.distance(from: lineText.startIndex, to: range.lowerBound)
            let end = lineText.distance(from: lineText.startIndex, to: range.upperBound)
            let token = String(lineText[range])
            let charIds = (start..<end).compactMap { charIdsByOffset[$0] }
            let sentenceId = String(format: "sentence-%04d", sentenceCounter)
            sentenceCounter += 1

            sentences.append(
                SentenceAnnotation(
                    id: sentenceId,
                    text: token,
                    pinyin: pinyin(for: token),
                    translation: nil,
                    characterIds: charIds
                )
            )

            for characterId in charIds {
                if let index = characters.firstIndex(where: { $0.id == characterId }) {
                    characters[index] = CharacterAnnotation(
                        id: characters[index].id,
                        text: characters[index].text,
                        box: characters[index].box,
                        wordId: characters[index].wordId,
                        sentenceId: sentenceId
                    )
                }
            }
        }
    }

    return PageAnnotation(
        sourceImage: url.lastPathComponent,
        characters: characters,
        words: words,
        sentences: sentences
    )
}

let config = parseArguments()
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
try FileManager.default.createDirectory(at: config.outputDir, withIntermediateDirectories: true)

for pageURL in imageURLs(in: config.inputDir) {
    do {
        fputs("OCR \(pageURL.lastPathComponent)\n", stderr)
        let annotation = try recognizePage(at: pageURL)
        let outputURL = config.outputDir.appendingPathComponent(pageURL.deletingPathExtension().lastPathComponent + ".json")
        let data = try encoder.encode(annotation)
        try data.write(to: outputURL)
    } catch {
        fputs("Failed OCR for \(pageURL.lastPathComponent): \(error)\n", stderr)
        let outputURL = config.outputDir.appendingPathComponent(pageURL.deletingPathExtension().lastPathComponent + ".json")
        let data = try encoder.encode(emptyAnnotation(for: pageURL))
        try data.write(to: outputURL)
    }
}
