// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "AegisKit",
    platforms: [.iOS(.v26), .macOS(.v15)],
    products: [
        .library(name: "AegisKit", targets: ["AegisKit"])
    ],
    targets: [
        .target(
            name: "AegisKit",
            resources: [.process("Resources")],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
        .testTarget(
            name: "AegisKitTests",
            dependencies: ["AegisKit"],
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
