import Foundation
import Testing
@testable import AegisKit

@Suite struct CoreScriptTests {
    private func raw(_ json: String) -> JSONValue { try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8)) }

    @Test func rendersDesktopTraceThroughJavaScriptCore() async throws {
        let script = CoreScript()
        let messages = [
            RemoteMessage(id: "p1", role: "user", text: "Run tests", streaming: nil, at: nil, raw: raw(#"{"type":"user_prompt","uuid":"p1","prompt":"Run tests","createdAt":1000}"#)),
            RemoteMessage(id: "a1", role: "assistant", text: "", streaming: nil, at: nil, raw: raw(#"{"type":"assistant","uuid":"a1","createdAt":2000,"message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test"}}]}}"#)),
            RemoteMessage(id: "r1", role: "tool", text: "", streaming: nil, at: nil, raw: raw(#"{"type":"user","uuid":"r1","createdAt":3000,"message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}"#)),
            RemoteMessage(id: "a2", role: "assistant", text: "Green", streaming: nil, at: nil, raw: raw(#"{"type":"assistant","uuid":"a2","createdAt":64000,"message":{"content":[{"type":"text","text":"Green"}]}}"#)),
        ]
        let model = await script.renderSession(messages: messages, running: false, status: "idle")
        #expect(model.structured)
        #expect(model.items.count == 3)
        guard case .work(_, let work) = model.items[1], case .stages(let group) = work.groups.first else {
            Issue.record("expected a work block"); return
        }
        #expect(work.label?.hasPrefix("Worked for") == true)
        #expect(group.stages.first?.commands.first?.text == "$ npm test\nok")
        #expect(model.lastAnswerText == "Green")
    }

    @Test func catalogResolvesSettingsLikeTheDesktop() async throws {
        let options = raw(#"{"codex":{"defaultModel":"gpt-5-codex","defaultReasoningEffort":"medium","options":[],"availableModels":[{"name":"gpt-5-codex","label":"GPT-5 Codex","enabled":true,"isDefault":true,"defaultReasoningEffort":"medium","supportedReasoningLevels":[{"effort":"low"},{"effort":"medium"},{"effort":"high"}],"supportsFastMode":true}]}}"#)
        let catalog = await CoreScript().catalog(provider: "codex", options: options)
        let resolved = catalog.resolve(RemoteTaskSettings(effort: "high", fast: true))
        #expect(resolved.modelLabel.isEmpty == false)
        #expect(resolved.effort == "high")
        #expect(resolved.fast)
        let request = catalog.requestSettings(RemoteTaskSettings(effort: "high", fast: true))
        #expect(request["effort"] == "high")
        #expect(request["fast"] == true)
        #expect(request["model"] == "gpt-5-codex")
        // No explicit effort: the Mac keeps its default.
        #expect(catalog.requestSettings(RemoteTaskSettings())["effort"] == nil)
    }

    @Test func describesRequests() async {
        let description = await CoreScript().describeRequest(#"{"command":"npm test","cwd":"/repo/app"}"#)
        #expect(description.label == "Command")
        #expect(description.fields == [["Directory", "app/"]])
    }
}
