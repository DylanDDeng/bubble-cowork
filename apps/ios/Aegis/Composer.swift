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
    @State private var menu: ComposerMenu?

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
            if expanded, let menu { CommandMenu(menu: menu, pick: pick) }
            if expanded && !model.attachments.isEmpty { AttachmentStrip() }
            if !expanded { attachMenu }
            TextField(placeholder, text: Binding(get: { model.draft }, set: { model.draft = $0 }), axis: .vertical)
                .lineLimit(expanded ? 1...7 : 1...1)
                .font(.app(16))
                .padding(.horizontal, expanded ? 6 : 2)
                .padding(.top, expanded ? 2 : 0)
                .focused($focused)
                .accessibilityLabel("Message")
            if expanded {
                HStack(spacing: 2) {
                    attachMenu
                    Menu { permissionItems } label: {
                        PermissionGlyph(permission: r.permission, size: 20)
                            .frame(width: 36, height: 36)
                            .contentShape(Circle())
                    }
                    .menuStyle(.button)
                    .buttonStyle(.plain)
                    .menuOrder(.fixed)
                    .accessibilityLabel("Permissions: \(r.permission?.label ?? "Default")")
                    if r.plan {
                        Menu { permissionItems } label: {
                            Label("Plan", systemImage: "checklist")
                                .font(.app(13, weight: .semibold))
                                .foregroundStyle(Color.ink)
                                .padding(.horizontal, 10)
                                .frame(height: 30)
                                .background(Color.fill2, in: .capsule)
                        }
                        .menuStyle(.button)
                        .buttonStyle(.plain)
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
                    PermissionGlyph(permission: r.permission, size: 18)
                        .frame(width: 28).accessibilityLabel(r.permission?.label ?? "Full access")
                }
                if r.plan {
                    Image(systemName: "checklist").font(.app(15, weight: .medium)).foregroundStyle(Color.text2)
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
        .task(id: MenuKey(draft: model.draft, scope: model.capabilityScope, list: model.capabilityLists[model.capabilityScope],
                          plan: catalog.supportsPlan, ready: model.ready)) {
            await updateMenu()
        }
        // Refreshed on focus, so "/" opens with a current list.
        .task(id: expanded && model.ready ? model.capabilityScope : nil) {
            if expanded { await model.loadCapabilities() }
        }
        .onDisappear { model.commandMenuOpen = false }
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

    // MARK: "/" and "$" menu

    private struct MenuKey: Equatable {
        let draft: String
        let scope: String
        let list: JSONValue?
        let plan: Bool
        /// Lists load once connected; a draft restored at launch waits for that.
        let ready: Bool
    }

    /// A draft that starts with "/" or "$" (after any @mentions) opens the menu.
    private func updateMenu() async {
        let draft = model.draft
        guard draft.contains(where: { $0 == "/" || $0 == "$" }) else { setMenu(nil); return }
        let scope = model.capabilityScope
        if model.capabilityLists[scope] == nil { await model.loadCapabilities() }
        // Nothing to list yet (still connecting, or an older Mac): typed commands still go through.
        guard let list = model.capabilityLists[scope] else { setMenu(nil); return }
        let next = await CoreScript.shared.composerMenu(provider: catalog.provider, draft: draft,
                                                        capabilities: list, supportsPlan: catalog.supportsPlan)
        guard !Task.isCancelled else { return }
        setMenu(next)
    }

    private func setMenu(_ next: ComposerMenu?) {
        guard next != menu else { return }
        withAnimation(.smooth(duration: 0.2)) {
            menu = next
            model.commandMenuOpen = next != nil
        }
    }

    private func pick(_ item: ComposerMenu.Item) {
        Haptics.select()
        switch item.action {
        case "plan":
            var next = settings
            next.plan = true
            onSettings(next)
            model.draft = item.draft
        case "model":
            model.draft = item.draft
            picker = true
        default:
            model.draft = item.draft
            if item.submit { Task { await model.send() } }
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
                .font(.app(19, weight: .medium))
                .foregroundStyle(Color.ink)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        // The default style puts a rounded-square platter behind the icon while the
        // menu opens and closes, which lingered after a dismiss.
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuOrder(.fixed)
        .accessibilityLabel("Add photos or files")
    }

    @ViewBuilder private var permissionItems: some View {
        Section("Permissions · \(providerLabel(catalog.provider))") {
            ForEach(catalog.permissionModes, id: \.mode) { mode in
                Button {
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
                ProviderGlyph(provider: catalog.provider, size: 14).foregroundStyle(Color.ink).padding(.trailing, 1)
                if r.fast {
                    Image(systemName: "bolt.fill").font(.app(11)).foregroundStyle(Color.accent)
                }
                Text(r.modelLabel).foregroundStyle(Color.ink).lineLimit(1)
                if let effort = r.effortLabel {
                    Text(effort).foregroundStyle(Color.text3).lineLimit(1).fixedSize()
                }
                Image(systemName: "chevron.down").font(.app(10, weight: .bold)).foregroundStyle(Color.text3)
            }
            .font(.app(13.5))
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
                .font(.app(running ? 11 : 16, weight: .bold))
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
                                        Text("\(Int(item.progress * 100))%").font(.app(12, weight: .semibold)).foregroundStyle(.white)
                                    }
                                }
                            }
                            .overlay {
                                if item.error != nil { RoundedRectangle(cornerRadius: 16).strokeBorder(Color.danger, lineWidth: 1.5) }
                            }
                            .overlay(alignment: .topTrailing) {
                                Button { model.removeAttachment(item.id) } label: {
                                    Image(systemName: "xmark")
                                        .font(.app(9, weight: .heavy))
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
                Text("\(failed.name): \(failed.error ?? "")").font(.app(12)).foregroundStyle(Color.danger)
            } else if model.attachments.contains(where: \.uploading) {
                Label("Uploading to your Mac · send unlocks when done", systemImage: "arrow.up.circle")
                    .font(.app(12)).foregroundStyle(Color.text2)
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
                    Image(systemName: "doc").font(.app(18))
                    Text(item.name).font(.app(9.5)).lineLimit(1)
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
            // A running conversation keeps its agent: the row shows it without the way to change it.
            Button { page = .agents } label: {
                HStack(spacing: 10) {
                    ProviderGlyph(provider: catalog.provider, size: 16)
                        .foregroundStyle(Color.text1)
                        .frame(width: 30, height: 30)
                        .background(Color.fill3, in: .rect(cornerRadius: 8))
                    Text(providerLabel(catalog.provider)).font(.app(15, weight: .medium)).foregroundStyle(Color.text1)
                    Spacer(minLength: 4)
                    Text("Agent").font(.app(13)).foregroundStyle(Color.text3)
                    if choosesAgent {
                        Image(systemName: "chevron.right").font(.app(11, weight: .bold)).foregroundStyle(Color.text3)
                    }
                }
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .allowsHitTesting(choosesAgent)
            .accessibilityLabel("Agent: \(providerLabel(catalog.provider))")
            Divider().overlay(Color.hair)
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
                                .font(.app(15, weight: .semibold))
                                .foregroundStyle(Color.accent)
                            Image(systemName: "chevron.right").font(.app(10, weight: .bold)).foregroundStyle(Color.text3)
                        }
                        if !r.efforts.isEmpty {
                            Text(r.modelLabel).font(.app(12)).foregroundStyle(Color.text2).lineLimit(1)
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
                Text("This model has no reasoning options.").font(.app(12)).foregroundStyle(Color.text3)
            } else {
                if r.efforts.count > 1 {
                    StepSlider(index: $index, count: r.efforts.count, valueLabel: r.effortLabel ?? "Default")
                        // No effort chosen and no model default: the Mac decides.
                        .opacity(r.shownEffort == nil ? 0.45 : 1)
                        .accessibilityLabel("Reasoning")
                        .padding(.horizontal, 4)
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
                            .font(.app(11.5, weight: effort.value == r.shownEffort ? .semibold : .regular))
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
                TextField("Search models", text: $query).font(.app(15))
            }
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background(Color.fill2, in: .rect(cornerRadius: 12))
            if items.isEmpty {
                Text(catalog.models.isEmpty ? "Loading models from your Mac…" : "No matching models.")
                    .font(.app(12)).foregroundStyle(Color.text3).padding(8)
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
                                        Text(item.label).font(.app(15.5, weight: .medium)).lineLimit(1)
                                        if let description = item.description {
                                            Text(description).font(.app(12.5)).foregroundStyle(Color.text2).lineLimit(1)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                    if selected { Image(systemName: "checkmark").font(.app(14, weight: .semibold)) }
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
                Image(systemName: "chevron.left").font(.app(13, weight: .semibold)).foregroundStyle(Color.text3)
                Text(title).font(.app(15, weight: .medium))
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
                            Text(providerLabel(p)).font(.app(15.5, weight: .medium)).foregroundStyle(Color.text1)
                            Text(model.describe(p)).font(.app(12.5)).foregroundStyle(Color.text2).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if selected { Image(systemName: "checkmark").font(.app(14, weight: .semibold)) }
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
                .font(.app(12)).foregroundStyle(Color.text3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 10).padding(.top, 4)
        }
    }
}

/// The reasoning slider from the design: a 32 pt capsule filled up to a white knob,
/// with a dot at each stop. Drag or tap snaps to the nearest stop.
struct StepSlider: View {
    @Binding var index: Double
    let count: Int
    let valueLabel: String

    private let knob: CGFloat = 32

    var body: some View {
        GeometryReader { geo in
            let span = max(1, geo.size.width - knob)
            let step = span / CGFloat(max(1, count - 1))
            let current = min(Double(count - 1), max(0, index.rounded()))
            let x = knob / 2 + step * CGFloat(current)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.text1.opacity(0.1))
                    .overlay(Capsule().strokeBorder(Color.hair, lineWidth: 0.5))
                Capsule().fill(Color.accent).frame(width: x + knob / 2)
                ForEach(0..<count, id: \.self) { stop in
                    Circle()
                        .fill(Double(stop) <= current ? Color.white.opacity(0.45) : Color.text1.opacity(0.25))
                        .frame(width: 5, height: 5)
                        .position(x: knob / 2 + step * CGFloat(stop), y: knob / 2)
                }
                Circle().fill(Color.white)
                    .overlay(Circle().strokeBorder(Color.black.opacity(0.04), lineWidth: 0.5))
                    .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)
                    .frame(width: knob, height: knob)
                    .position(x: x, y: knob / 2)
            }
            .frame(height: knob)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                let stop = ((drag.location.x - knob / 2) / step).rounded()
                let next = Double(min(CGFloat(count - 1), max(0, stop)))
                if next != current {
                    Haptics.select()
                    withAnimation(.snappy(duration: 0.18)) { index = next }
                }
            })
        }
        .frame(height: 40)
        .accessibilityElement()
        .accessibilityValue(valueLabel)
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: index = min(Double(count - 1), index.rounded() + 1)
            case .decrement: index = max(0, index.rounded() - 1)
            @unknown default: break
            }
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

/// The desktop composer's permission mark: a shield with a check for the gated
/// modes, the enclosed-exclamation shield in orange for Full Access, and red for
/// modes the provider marks dangerous.
struct PermissionGlyph: View {
    let permission: AgentCatalog.PermissionMode?
    let size: CGFloat

    var body: some View {
        let tone = permission?.tone
        let color = tone == "full-access" ? Color.fullAccess : tone == "danger" ? Color.danger : Color.text2
        Group {
            if tone == "full-access" {
                FullAccessShield(lineWidth: 1.65 * size / 20)
            } else {
                Image(systemName: "checkmark.shield").font(.system(size: size * 0.85, weight: .medium))
            }
        }
        .foregroundStyle(color)
        .frame(width: size, height: size)
    }
}

/// FullAccessPermissionIcon.tsx, drawn on its 20-unit grid.
private struct FullAccessShield: View {
    let lineWidth: CGFloat

    var body: some View {
        GeometryReader { geo in
            let u = min(geo.size.width, geo.size.height) / 20
            let p = { (x: CGFloat, y: CGFloat) in CGPoint(x: x * u, y: y * u) }
            ZStack {
                Path { path in
                    path.move(to: p(10, 3.05))
                    path.addCurve(to: p(16.5, 5.09), control1: p(12.34, 3.81), control2: p(14.55, 4.39))
                    path.addLine(to: p(16.5, 8.32))
                    path.addCurve(to: p(10, 16.35), control1: p(16.5, 11.74), control2: p(14.14, 14.4))
                    path.addCurve(to: p(3.5, 8.32), control1: p(5.86, 14.4), control2: p(3.5, 11.74))
                    path.addLine(to: p(3.5, 5.09))
                    path.addCurve(to: p(10, 3.05), control1: p(5.45, 4.39), control2: p(7.66, 3.81))
                    path.closeSubpath()
                    path.move(to: p(10, 6.25))
                    path.addLine(to: p(10, 10.4))
                }
                .stroke(style: StrokeStyle(lineWidth: lineWidth, lineCap: .round, lineJoin: .round))
                Path { $0.addEllipse(in: CGRect(origin: p(9.15, 12), size: CGSize(width: 1.7 * u, height: 1.7 * u))) }
                    .fill()
            }
        }
    }
}

/// The desktop composer's command and skill menu, above the text field.
private struct CommandMenu: View {
    let menu: ComposerMenu
    let pick: (ComposerMenu.Item) -> Void
    @State private var height: CGFloat = 0

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if menu.groups.isEmpty {
                    Text(menu.emptyMessage).font(.app(13)).foregroundStyle(Color.text3)
                        .padding(.horizontal, 8).padding(.vertical, 10)
                }
                ForEach(Array(menu.groups.enumerated()), id: \.element.id) { index, group in
                    if index > 0 { Rectangle().fill(Color.hair).frame(height: 0.5).padding(.vertical, 4) }
                    if let label = group.label {
                        Text(label).font(.app(12)).foregroundStyle(Color.text3)
                            .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 2)
                    }
                    ForEach(group.items) { item in row(item) }
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height = $0 }
        }
        .scrollIndicators(.hidden)
        .scrollBounceBehavior(.basedOnSize)
        // As tall as its rows, up to three and a half so the cut row says it scrolls.
        .frame(height: min(height, 196))
        .accessibilityLabel(menu.title)
    }

    private func row(_ item: ComposerMenu.Item) -> some View {
        Button { pick(item) } label: {
            HStack(spacing: 10) {
                Image(systemName: Self.symbol(item.glyph))
                    .font(.app(14, weight: .medium)).foregroundStyle(Color.text2)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(item.title).font(.app(15, weight: .medium)).foregroundStyle(Color.ink).lineLimit(1)
                    if let detail = item.detail {
                        Text(detail).font(.app(12.5)).foregroundStyle(Color.text2).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                Text(item.meta).font(.app(12)).foregroundStyle(Color.text3).lineLimit(1)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityHint(item.detail ?? "")
    }

    /// SF Symbols for the desktop menu's icons (slash-menu.ts glyphs).
    static func symbol(_ glyph: String) -> String {
        switch glyph {
        case "clear": "trash"
        case "rewind": "arrow.counterclockwise"
        case "usage": "gauge.with.dots.needle.33percent"
        case "fast": "bolt"
        case "fork": "arrow.triangle.branch"
        case "brain": "brain"
        case "plan": "checklist"
        case "goal": "target"
        case "review": "ladybug"
        case "agents": "point.3.connected.trianglepath.dotted"
        case "plugin": "powerplug"
        case "help": "book"
        case "thread": "bubble.left"
        case "skill": "square.stack.3d.up"
        default: "terminal"
        }
    }
}
