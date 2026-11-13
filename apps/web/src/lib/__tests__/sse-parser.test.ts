import { describe, expect, it } from "vitest";
import { SseParser, type SseMessage } from "../sse-parser.js";

function feed(chunks: readonly string[]): SseMessage[] {
  const parser = new SseParser();
  return [...chunks.flatMap((chunk) => parser.push(chunk)), ...parser.end()];
}

describe("SseParser", () => {
  it("parses named events with JSON data", () => {
    expect(feed(['event: delta\ndata: {"text":"Hi"}\n\n'])).toEqual([
      { event: "delta", data: '{"text":"Hi"}', id: null },
    ]);
  });

  it("reassembles an event split at every possible byte boundary", () => {
    const stream = 'event: retrieval\ndata: {"a":1}\n\nevent: delta\ndata: {"text":"[PER_89A1]"}\n\n';
    const expected = feed([stream]);
    for (let cut = 1; cut < stream.length; cut += 1) {
      expect(feed([stream.slice(0, cut), stream.slice(cut)])).toEqual(expected);
    }
    expect(feed([...stream])).toEqual(expected);
  });

  it("handles CRLF, CR and a CRLF pair split across chunks", () => {
    expect(feed(["event: a\r\ndata: 1\r", "\n\r\n", "event: b\rdata: 2\r\r"])).toEqual([
      { event: "a", data: "1", id: null },
      { event: "b", data: "2", id: null },
    ]);
  });

  it("joins multi-line data, strips one leading space, ignores comments and unknown fields", () => {
    expect(feed([": keep-alive\nretry: 10\nfoo: bar\ndata:  two spaces\ndata:line2\n\n"])).toEqual([
      { event: "message", data: " two spaces\nline2", id: null },
    ]);
  });

  it("does not dispatch an event without data, and resets the event name after a blank line", () => {
    expect(feed(["event: ping\n\ndata: x\n\n"])).toEqual([{ event: "message", data: "x", id: null }]);
  });

  it("tracks the last event id", () => {
    expect(feed(["id: 7\ndata: a\n\ndata: b\n\n"]).map((m) => m.id)).toEqual(["7", "7"]);
  });

  it("drops an unterminated trailing event at end of stream", () => {
    expect(feed(["data: complete\n\n", "data: cut off"])).toEqual([{ event: "message", data: "complete", id: null }]);
  });
});
