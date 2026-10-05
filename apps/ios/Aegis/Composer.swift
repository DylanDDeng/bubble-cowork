import AegisKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The desktop composer on iOS 26 Liquid Glass: text, attachments, permissions,
/// plan-first, model and reasoning, send/stop.
struct Composer: View {
    @Environment(AppModel.self) private var model
    let catalog: AgentCatalog
    let settings: RemoteTaskSettings
    let onSettings: (RemoteTaskSettings) -> Void
    let placeholder: String
    let running: Bool
    let canStop: Bool
    /// New tasks can switch agents from the model picker; a session's agent is fixed.
    var choosesAgent = false

    @FocusState private var focused: Bool
    @State private var picker = false
    @State private var photos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var files = false
    @State private var camera = false

    private var r: ResolvedSettings { catalog.resolve(settings) }
    private var expanded: Bool { focused || picker || !model.draft.isEmpty || !model.attachments.isEmpty }

    var body: some View {
        @Bindable var model = model
        // Collapsed it is a single-line pill; focused (or holding a draft) it opens
        // into the full composer. AnyLayout keeps the text field's identity, so
        // focus survives the change.
        let layout = expanded
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 10))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 2))
        layout {
            if expanded && !model.attachments.isEmpty { AttachmentStrip() }
            if !expanded { attachMenu }
            TextField(placeholder, text: Binding(get: { model.draft }, set: { model.draft = $0 }), axis: .vertical)
                .lineLimit(expanded ? 1...7 : 1...1)
                .font(.system(size: 17))
                .padding(.horizontal, expanded ? 6 : 2)
                .padding(.top, expanded ? 2 : 0)
                .focused($focused)
                .accessibilityLabel("Message")
            if expanded {
                HStack(spacing: 2) {
                    attachMenu
                    Menu { permissionItems } label: {
                        Image(systemName: r.isFullAccess ? "shield.slash" : "shield")
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(r.isFullAccess ? Color.danger : Color.text2)
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .menuOrder(.fixed)
                    .accessibilityLabel("Permissions: \(r.permission?.label ?? "Default")")
                    if r.plan {
                        Menu { permissionItems } label: {
                            Label("Plan", systemImage: "checklist")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundStyle(Color.ink)
                                .padding(.horizontal, 10)
                                .frame(height: 30)
                                .background(Color.fill2, in: .capsule)
                        }
                        .menuOrder(.fixed)
                        .padding(.leading, 2)
                        .accessibilityLabel("Plan first is on")
                    }
                    Spacer(minLength: 4)
                    modelChip
                    sendButton
                }
            } else {
                // Settings that change what the agent may do stay visible.
                if r.isFullAccess {
                    Image(systemName: "shield.slash").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.danger)
                        .frame(width: 28).accessibilityLabel("Full access")
                }
                if r.plan {
                    Image(systemName: "checklist").font(.system(size: 15, weight: .medium)).foregroundStyle(Color.text2)
                        .frame(width: 28).accessibilityLabel("Plan first")
                }
                sendButton
            }
        }
        .padding(expanded ? EdgeInsets(top: 12, leading: 12, bottom: 10, trailing: 12) : EdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 7))
        .glassEffect(.regular, in: .rect(cornerRadius: expanded ? 28 : 25))
        .contentShape(.rect(cornerRadius: 28))
        .onTapGesture { focused = true }
        .padding(.horizontal, expanded ? 0 : 14)
        .animation(.smooth(duration: 0.32), value: expanded)
        .photosPicker(isPresented: $photos, selection: $photoItems, maxSelectionCount: 10, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .fileImporter(isPresented: $files, allowedContentTypes: allowedTypes, allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(10) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url) else { continue }
                let image = UTType(filenameExtension: url.pathExtension)?.conforms(to: .image) == true ? UIImage(data: data) : nil
                model.addAttachment(name: url.lastPathComponent, data: data, image: image?.preparingThumbnail(of: CGSize(width: 160, height: 160)))
            }
        }
        .fullScreenCover(isPresented: $camera) {
            CameraPicker { image in
                if let image, let data = image.jpegData(compressionQuality: 0.85) {
                    model.addAttachment(name: "photo.jpg", data: data, image: image.preparingThumbnail(of: CGSize(width: 160, height: 160)))
                }
            }
            .ignoresSafeArea()
        }
    }

    private var allowedTypes: [UTType] {
        var types: [UTType] = [.plainText, .json, .log, .pdf, .png, .jpeg, .webP, .gif]
        if let md = UTType(filenameExtension: "md") { types.append(md) }
        if let docx = UTType("org.openxmlformats.wordprocessingml.document") { types.append(docx) }
        return types
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            let type = item.supportedContentTypes.first { [.png, .gif, .webP].contains($0) } ?? .jpeg
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let image = UIImage(data: data)
            // HEIC and other formats are sent as JPEG, like the Mac expects.
            let payload = type == .jpeg ? (image?.jpegData(compressionQuality: 0.9) ?? data) : data
            model.addAttachment(name: "photo.\(type.preferredFilenameExtension ?? "jpg")", data: payload,
                                image: image?.preparingThumbnail(of: CGSize(width: 160, height: 160)))
        }
    }

    private var attachMenu: some View {
        Menu {
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("Camera", systemImage: "camera") { camera = true }
            }
            Button("Photos", systemImage: "photo.on.rectangle") { photos = true }
            Button("Files", systemImage: "doc") { files = true }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .menuOrder(.fixed)
        .accessibilityLabel("Add photos or files")
    }

    @ViewBuilder private var permissionItems: some View {
        Section("Permissions · \(providerLabel(catalog.provider))") {
            ForEach(catalog.permissionModes, id: \.mode) { mode in
                Button(role: mode.isFullAccess ? .destructive : nil) {
                    var next = settings
                    next.permissionMode = mode.mode
                    onSettings(next)
                } label: {
                    if mode.mode == r.permissionMode { Label(mode.label, systemImage: "checkmark") } else { Text(mode.label) }
                }
            }
        }
        if catalog.supportsPlan {
            Section {
                Toggle(isOn: Binding(get: { r.plan }, set: { on in
                    var next = settings
                    next.plan = on
                    onSettings(next)
                })) {
                    Text("Plan first")
                    Text("Read-only until a plan is approved")
                }
            }
        }
    }

    private var modelChip: some View {
        Button { picker = true } label: {
            HStack(spacing: 4) {
                if choosesAgent {
                    ProviderGlyph(provider: catalog.provider, size: 14).foregroundStyle(Color.ink).padding(.trailing, 1)
                }
                if r.fast {
                    Image(systemName: "bolt.fill").font(.system(size: 11)).foregroundStyle(Color.accent)
                }
                Text(r.modelLabel).foregroundStyle(Color.ink).lineLimit(1)
                if let effort = r.effortLabel {
                    Text(effort).foregroundStyle(Color.text3).lineLimit(1).fixedSize()
                }
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.text3)
            }
            .font(.system(size: 13.5))
            .padding(.horizontal, 8)
            .frame(height: 36)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(choosesAgent ? providerLabel(catalog.provider) + ", " : "")Model and reasoning: \(r.modelLabel)\(r.effortLabel.map { ", \($0)" } ?? "")")
        .popover(isPresented: $picker, arrowEdge: .bottom) {
            ModelPicker(catalog: catalog, settings: settings, onSettings: onSettings, choosesAgent: choosesAgent)
                .presentationCompactAdaptation(.popover)
        }
    }

    private var sendButton: some View {
        let enabled = running ? canStop : model.canSend
        return Button {
            Haptics.tap()
            Task { running ? await model.stop() : await model.send() }
        } label: {
            Image(systemName: running ? "stop.fill" : "arrow.up")
                .font(.system(size: running ? 11 : 16, weight: .bold))
                .foregroundStyle(enabled ? Color.onInk : Color.page)
                .frame(width: 34, height: 34)
                .background(Circle().fill(enabled ? Color.ink : Color.inkOff))
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(running ? "Stop this turn" : "Send")
    }
}

private struct AttachmentStrip: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(model.attachments) { item in
                        thumb(item)
                            .frame(width: 64, height: 64)
                            .clipShape(.rect(cornerRadius: 16))
                            .overlay {
                                if item.uploading {
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 16).fill(.black.opacity(0.38))
                                        Text("\(Int(item.progress * 100))%").font(.system(size: 12, weight: .semibold)).foregroundStyle(.white)
                                    }
                                }
                            }
                            .overlay {
                                if item.error != nil { RoundedRectangle(cornerRadius: 16).strokeBorder(Color.danger, lineWidth: 1.5) }
                            }
                            .overlay(alignment: .topTrailing) {
                                Button { model.removeAttachment(item.id) } label: {
                                    Image(systemName: "xmark")
                                        .font(.system(size: 9, weight: .heavy))
                                        .foregroundStyle(Color.onInk)
                                        .frame(width: 22, height: 22)
                                        .background(Circle().fill(Color.ink))
                                }
                                .buttonStyle(.plain)
                                .offset(x: 6, y: -6)
                                .accessibilityLabel("Remove \(item.name)")
                            }
                    }
                }
                .padding(.top, 6)
                .padding(.trailing, 6)
            }
            if let failed = model.attachments.first(where: { $0.error != nil }) {
                Text("\(failed.name): \(failed.error ?? "")").font(.system(size: 12)).foregroundStyle(Color.danger)
            } else if model.attachments.contains(where: \.uploading) {
                Label("Uploading to your Mac · send unlocks when done", systemImage: "arrow.up.circle")
                    .font(.system(size: 12)).foregroundStyle(Color.text2)
            }
        }
        .padding(.horizontal, 6)
    }

    @ViewBuilder private func thumb(_ item: PendingAttachment) -> some View {
        if let image = item.image {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            ZStack {
                Color.fill3
                VStack(spacing: 2) {
                    Image(systemName: "doc").font(.system(size: 18))
                    Text(item.name).font(.system(size: 9.5)).lineLimit(1)
                }
                .foregroundStyle(Color.text2)
                .padding(4)
            }
        }
    }
}

/// Desktop EffortModelPanel: reasoning first, model underneath, model list behind it.
struct ModelPicker: View {
    let catalog: AgentCatalog
    let settings: RemoteTaskSettings
    let onSettings: (RemoteTaskSettings) -> Void
    var choosesAgent = false
    @Environment(AppModel.self) private var model
    @State private var page = Page.settings
    @State private var query = ""
    @State private var index = 0.0

    private var r: ResolvedSettings { catalog.resolve(settings) }

    var body: some View {
        Group {
            switch page {
            case .settings: compact
            case .models: models
            case .agents: agents
            }
        }
            .padding(12)
            .frame(width: 300)
    }

    private func set(_ change: (inout RemoteTaskSettings) -> Void) {
        var next = settings
        change(&next)
        onSettings(next)
    }

    private enum Page { case settings, models, agents }

    private var position: Double { Double(r.efforts.firstIndex { $0.value == r.shownEffort } ?? 0) }

    private var compact: some View {
        VStack(spacing: 10) {
            if choosesAgent {
                Button { page = .agents } label: {
                    HStack(spacing: 10) {
                        ProviderGlyph(provider: catalog.provider, size: 16)
                            .foregroundStyle(Color.text1)
                            .frame(width: 30, height: 30)
                            .background(Color.fill3, in: .rect(cornerRadius: 8))
                        Text(providerLabel(catalog.provider)).font(.system(size: 15, weight: .medium)).foregroundStyle(Color.text1)
                        Spacer(minLength: 4)
                        Text("Agent").font(.system(size: 13)).foregroundStyle(Color.text3)
                        Image(systemName: "chevron.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Color.text3)
                    }
                    .padding(.horizontal, 4)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Agent: \(providerLabel(catalog.provider))")
                Divider().overlay(Color.hair)
            }
            HStack(alignment: .top, spacing: 0) {
                Group {
                    if r.fastAvailable {
                        Button { set { $0.fast = !r.fast } } label: {
                            Image(systemName: r.fast ? "bolt.fill" : "bolt")
                                .foregroundStyle(r.fast ? Color.accent : Color.text3)
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(r.fast ? "Turn off Fast mode" : "Fast mode · Increased usage")
                    }
                }
                .frame(width: 32)
                Button { page = .models } label: {
                    VStack(spacing: 1) {
                        HStack(spacing: 3) {
                            Text(r.efforts.isEmpty ? r.modelLabel : (r.effortLabel ?? "Default"))
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(Color.accent)
                            Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.text3)
                        }
                        if !r.efforts.isEmpty {
                            Text(r.modelLabel).font(.system(size: 12)).foregroundStyle(Color.text2).lineLimit(1)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Choose model")
                Group {
                    if !r.efforts.isEmpty {
                        Button { set { $0.effort = nil } } label: {
                            Image(systemName: "arrow.counterclockwise").foregroundStyle(Color.text3).frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .disabled(settings.effort == nil)
                        .opacity(settings.effort == nil ? 0.35 : 1)
                        .accessibilityLabel("Reset reasoning to default")
                    }
                }
                .frame(width: 32)
            }
            if r.efforts.isEmpty {
                Text("This model has no reasoning options.").font(.system(size: 12)).foregroundStyle(Color.text3)
            } else {
                if r.efforts.count > 1 {
                    Slider(value: $index, in: 0...Double(r.efforts.count - 1), step: 1)
                        .tint(Color.accent)
                        // No effort chosen and no model default: the Mac decides.
                        .opacity(r.shownEffort == nil ? 0.45 : 1)
                        .accessibilityLabel("Reasoning")
                        .onChange(of: index) { _, value in
                            let effort = r.efforts[min(r.efforts.count - 1, max(0, Int(value.rounded())))]
                            if effort.value != r.shownEffort { set { $0.effort = effort.value } }
                        }
                }
                HStack(spacing: 0) {
                    ForEach(Array(r.efforts.enumerated()), id: \.element.value) { offset, effort in
                        if offset > 0 { Spacer(minLength: 2) }
                        Button(effort.label) { set { $0.effort = effort.value } }
                            .buttonStyle(.plain)
                            .font(.system(size: 11.5, weight: effort.value == r.shownEffort ? .semibold : .regular))
                            .foregroundStyle(effort.value == r.shownEffort ? Color.accent : Color.text3)
                    }
                }
            }
        }
        .onAppear { index = position }
        .onChange(of: r.shownEffort) { index = position }
    }

    private var models: some View {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let items = catalog.models.filter { q.isEmpty || $0.label.lowercased().contains(q) || ($0.description ?? "").lowercased().contains(q) }
        return VStack(alignment: .leading, spacing: 6) {
            backButton("Models")
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(Color.text3)
                TextField("Search models", text: $query).font(.system(size: 15))
            }
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(Color.fill2, in: .rect(cornerRadius: 12))
            if items.isEmpty {
                Text(catalog.models.isEmpty ? "Loading models from your Mac…" : "No matching models.")
                    .font(.system(size: 12)).foregroundStyle(Color.text3).padding(8)
            } else {
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(items, id: \.self) { item in
                            let selected = item.value == r.model && item.compatibleProviderId == r.compatibleProviderId
                            Button {
                                set {
                                    $0.model = item.value
                                    $0.compatibleProviderId = item.compatibleProviderId
                                    $0.effort = nil
                                }
                                page = .settings
                            } label: {
                                HStack(spacing: 12) {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(item.label).font(.system(size: 15.5, weight: .medium)).lineLimit(1)
                                        if let description = item.description {
                                            Text(description).font(.system(size: 12.5)).foregroundStyle(Color.text2).lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    if selected { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)) }
                                }
                                .padding(.horizontal, 10)
                                .frame(minHeight: 46)
                                .background(selected ? Color.fill2 : .clear, in: .rect(cornerRadius: 12))
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .frame(height: min(340, CGFloat(items.count) * 50))
            }
        }
    }

    private func backButton(_ title: String) -> some View {
        Button { page = .settings } label: {
            HStack(spacing: 8) {
                Image(systemName: "chevron.left").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.text3)
                Text(title).font(.system(size: 15, weight: .medium))
            }
            .frame(height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// Agents on the Mac, each with its logo and current model · reasoning.
    private var agents: some View {
        VStack(alignment: .leading, spacing: 2) {
            backButton("Agents on \(model.macName)")
            ForEach(agentProviders, id: \.self) { p in
                let selected = p == catalog.provider
                Button {
                    Haptics.tap()
                    model.provider = p
                    page = .settings
                } label: {
                    HStack(spacing: 12) {
                        ProviderGlyph(provider: p, size: 18)
                            .foregroundStyle(Color.text1)
                            .frame(width: 32, height: 32)
                            .background(Color.fill3, in: .rect(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(providerLabel(p)).font(.system(size: 15.5, weight: .medium)).foregroundStyle(Color.text1)
                            Text(model.describe(p)).font(.system(size: 12.5)).foregroundStyle(Color.text2).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if selected { Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)) }
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 52)
                    .background(selected ? Color.fill2 : .clear, in: .rect(cornerRadius: 12))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            Text("Uses the agents and sign-ins configured in Aegis on your Mac.")
                .font(.system(size: 12)).foregroundStyle(Color.text3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10).padding(.top, 4)
        }
    }
}

struct CameraPicker: UIViewControllerRepresentable {
    let onDone: (UIImage?) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            parent.onDone(info[.originalImage] as? UIImage)
            parent.dismiss()
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onDone(nil)
            parent.dismiss()
        }
    }
}
