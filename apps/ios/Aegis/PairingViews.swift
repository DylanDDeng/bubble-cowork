import AegisKit
import SwiftUI
import VisionKit

struct WelcomeView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack(alignment: .topLeading) {
                RoundedRectangle(cornerRadius: 30).fill(Color.fill2).frame(width: 286, height: 216).offset(x: 22, y: 34)
                preview(icon: "checkmark.shield", tint: Color.warn, tintBg: Color.warnBg, caption: "Needs you", title: "Approve npm run test")
                    .rotationEffect(.degrees(-2)).offset(x: 10, y: 10)
                preview(spinner: true, caption: "Running · 2m", title: "Refactor stream batching")
                    .rotationEffect(.degrees(1.5)).offset(x: 34, y: 104)
                preview(icon: "checkmark", tint: Color.success, caption: "Done", title: "Update onboarding copy")
                    .rotationEffect(.degrees(-1)).offset(x: 16, y: 198)
            }
            .frame(width: 330, height: 290, alignment: .topLeading)
            .frame(maxWidth: .infinity)
            .accessibilityHidden(true)
            .padding(.top, 40)

            VStack(alignment: .leading, spacing: 12) {
                Text("Work on your Mac,\nfrom anywhere.").font(.system(size: 32, weight: .bold)).tracking(-0.8)
                Text("Follow running tasks, answer approvals and start new work while your Mac does the heavy lifting.")
                    .font(.system(size: 17)).foregroundStyle(Color.text2)
            }
            .padding(.horizontal, 28)
            .padding(.top, 30)

            Spacer()
            VStack(spacing: 14) {
                Button("Connect your Mac") { model.pairOpen = true }
                    .buttonStyle(PillButtonStyle(kind: .primary, height: 56))
                Label("End-to-end encrypted · Code stays on your Mac", systemImage: "lock")
                    .font(.system(size: 13)).foregroundStyle(Color.text2)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 16)
        }
        .background(Color.page)
    }

    private func preview(icon: String? = nil, spinner: Bool = false, tint: Color = Color.text1, tintBg: Color = Color.fill2, caption: String, title: String) -> some View {
        HStack(spacing: 12) {
            Group {
                if spinner { ProgressView() } else { Image(systemName: icon ?? "circle").font(.system(size: 16, weight: .semibold)).foregroundStyle(tint) }
            }
            .frame(width: 34, height: 34)
            .background(tintBg, in: .circle)
            VStack(alignment: .leading, spacing: 2) {
                Text(caption).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.text2)
                Text(title).font(.system(size: 15, weight: .semibold))
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .frame(width: 286)
        .glassEffect(.regular, in: .rect(cornerRadius: 22))
    }
}

struct PairSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var scanning = false

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text("Connect your Mac").font(.system(size: 22, weight: .bold))
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .bold)).foregroundStyle(Color.text2)
                        .frame(width: 32, height: 32).background(Color.fill2, in: .circle)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            VStack(alignment: .leading, spacing: 12) {
                step(1, Text("Open Aegis on your Mac"))
                step(2, Text("Go to ") + Text("Settings → General → iPhone Access").bold())
                step(3, Text("Turn it on and show the pairing code"))
            }
            if DataScannerViewController.isSupported {
                Button { scanning = true } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
                    .buttonStyle(PillButtonStyle(kind: .primary, height: 52))
                    .disabled(model.busy)
                HStack(spacing: 12) {
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                    Text("or paste a link").font(.system(size: 13)).foregroundStyle(Color.text3).fixedSize()
                    Rectangle().fill(Color.hair).frame(height: 0.5)
                }
            }
            HStack(spacing: 8) {
                Image(systemName: "link").foregroundStyle(Color.text3)
                TextField("aegis://pair#…", text: $model.pairText, axis: .vertical)
                    .lineLimit(1...3)
                    .font(.system(size: 15))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button {
                    Task { await model.pair(model.pairText) }
                } label: {
                    if model.busy { ProgressView().tint(Color.onInk) } else { Text("Connect") }
                }
                .buttonStyle(PillButtonStyle(kind: .primary, height: 36))
                .frame(width: 96)
                .disabled(model.busy || model.pairText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.leading, 14).padding(.trailing, 8).padding(.vertical, 8)
            .background(Color.fill2, in: .rect(cornerRadius: 16))
            if !model.notice.isEmpty || !model.client.error.isEmpty {
                Text(model.notice.isEmpty ? model.client.error : model.notice)
                    .font(.system(size: 13)).foregroundStyle(Color.danger)
            }
            Text("Pairing codes expire after 2 minutes.")
                .font(.system(size: 13)).foregroundStyle(Color.text2).frame(maxWidth: .infinity)
        }
        .padding(.horizontal, 20)
        .padding(.top, 24)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .fullScreenCover(isPresented: $scanning) {
            QRScanner { value in
                scanning = false
                if let value {
                    model.pairText = value
                    Task { await model.pair(value) }
                }
            }
            .ignoresSafeArea()
        }
    }

    private func step(_ n: Int, _ text: Text) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text("\(n)").font(.system(size: 13, weight: .semibold)).frame(width: 24, height: 24).background(Color.fill2, in: .circle)
            text.font(.system(size: 15))
        }
    }
}

/// Live QR scanning; only Aegis pairing links are accepted.
struct QRScanner: UIViewControllerRepresentable {
    let onResult: (String?) -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        scanner.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { _ in onResult(nil) })
        try? scanner.startScanning()
        return UINavigationController(rootViewController: scanner)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onResult: onResult) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onResult: (String?) -> Void
        private var done = false
        init(onResult: @escaping (String?) -> Void) { self.onResult = onResult }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                guard !done, let value = code.payloadStringValue,
                      value.hasPrefix("aegis://pair#") || value.hasPrefix("aegis-dev://pair#") else { continue }
                done = true
                scanner.stopScanning()
                onResult(value)
            }
        }
    }
}

struct ConfirmOnMacView: View {
    @Environment(AppModel.self) private var model
    @State private var pulse = false

    var body: some View {
        let tail = String(model.client.peerId.suffix(8)).uppercased()
        VStack(spacing: 20) {
            ZStack {
                Circle().strokeBorder(Color.hair, lineWidth: 1).frame(width: 96, height: 96).opacity(pulse ? 1 : 0.3)
                Image(systemName: "laptopcomputer").font(.system(size: 30)).frame(width: 72, height: 72).background(Color.fill2, in: .circle)
            }
            .onAppear { withAnimation(.easeInOut(duration: 1).repeatForever()) { pulse = true } }
            Text("Confirm on your Mac").font(.system(size: 26, weight: .bold))
            (Text("Aegis on ") + Text(model.client.pairing?.name ?? "your Mac").bold().foregroundStyle(Color.text1)
             + Text(" is asking to allow this iPhone. Check that the device ID on your Mac ends with:"))
                .font(.system(size: 16)).foregroundStyle(Color.text2).multilineTextAlignment(.center)
            Text(tail.isEmpty ? "…" : "\(tail.prefix(4)) \(tail.dropFirst(4))")
                .font(.system(size: 26, weight: .semibold, design: .monospaced)).tracking(3)
                .padding(.horizontal, 22).padding(.vertical, 16)
                .background(Color.fill2, in: .rect(cornerRadius: 22))
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                Text("Waiting for your Mac…")
            }
            .font(.system(size: 13)).foregroundStyle(Color.text2)
            Spacer()
            VStack(spacing: 12) {
                Text("Doesn’t match? Cancel and pair again.").font(.system(size: 13)).foregroundStyle(Color.text3)
                Button("Cancel") { Task { await model.client.disconnect(forget: true) } }
                    .buttonStyle(PillButtonStyle(kind: .secondary, height: 52))
                    .background(Color.fill2, in: .capsule)
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 100)
        .padding(.bottom, 16)
        .background(Color.page)
    }
}
