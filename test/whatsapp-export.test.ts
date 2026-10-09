import { describe, expect, it } from "vitest";
import { buildQAPairs, parseWhatsAppExport, redact } from "../scripts/lib/whatsapp-export.ts";

const IOS = `[3/10/24, 9:00:01 PM] Halacha Q&A: \u200eMessages and calls are end-to-end encrypted.
[3/10/24, 9:01:15 PM] David: Can I use the same sponge for meat and dairy dishes?
[3/10/24, 9:01:40 PM] Sarah: \u200eimage omitted
[3/10/24, 9:30:05\u202fPM] Rabbi Cohen: No, you should have separate sponges for meat and dairy.
If you used the wrong one, the dishes are generally fine if washed with cold water.
[3/10/24, 9:31:00 PM] Rabbi Cohen: (Assuming no hot water was used)
[3/11/24, 8:00:00 AM] Moshe: Thank you!
[3/11/24, 8:05:00 AM] Rabbi Cohen: 👍
[3/12/24, 7:00:00 AM] Rabbi Cohen: Reminder: candle lighting this Friday is 18 minutes before sunset.`;

const ANDROID = `15/04/2024, 21:41 - Messages and calls are end-to-end encrypted.
15/04/2024, 21:42 - Yossi: Is it ok to brush teeth on Yom Kippur? Call me +1 (917) 555-1234
15/04/2024, 22:10 - +972 50-123-4567: Not with toothpaste. <This message was edited>
16/04/2024, 09:00 - Avi: <Media omitted>`;

describe("parseWhatsAppExport", () => {
  it("parses iOS exports with multi-line messages and drops system/media noise", () => {
    const msgs = parseWhatsAppExport(IOS);
    expect(msgs.map((m) => m.sender)).toEqual([
      "David",
      "Rabbi Cohen",
      "Rabbi Cohen",
      "Moshe",
      "Rabbi Cohen",
      "Rabbi Cohen",
    ]);
    expect(msgs[1].text).toContain("\nIf you used the wrong one");
    expect(msgs[0].date).toBe("2024-03-10");
  });

  it("parses Android exports with day-first dates and 24h time", () => {
    const msgs = parseWhatsAppExport(ANDROID);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].date).toBe("2024-04-15");
    expect(msgs[1].sender).toBe("+972 50-123-4567");
    expect(msgs[1].text).toBe("Not with toothpaste.");
  });
});

describe("buildQAPairs", () => {
  it("pairs rabbi answer blocks with preceding questions and skips tiny replies", () => {
    const pairs = buildQAPairs(parseWhatsAppExport(IOS), { rabbiNames: ["rabbi cohen"] });
    expect(pairs).toHaveLength(2);
    expect(pairs[0].question).toBe("Can I use the same sponge for meat and dairy dishes?");
    expect(pairs[0].answer).toContain("separate sponges");
    expect(pairs[0].answer).toContain("(Assuming no hot water was used)"); // merged block
    expect(pairs[1].question).toBe(""); // standalone post
    expect(pairs[1].text).toMatch(/^Rabbi's post:/);
  });

  it("produces stable ids", () => {
    const a = buildQAPairs(parseWhatsAppExport(IOS), { rabbiNames: ["Cohen"] });
    const b = buildQAPairs(parseWhatsAppExport(IOS), { rabbiNames: ["Cohen"] });
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
  });

  it("matches the rabbi by phone number and redacts other phone numbers", () => {
    const pairs = buildQAPairs(parseWhatsAppExport(ANDROID), { rabbiNames: ["50-123-4567"] });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].question).toContain("[phone]");
    expect(pairs[0].question).not.toContain("555");
  });
});

describe("redact", () => {
  it("keeps dates and source references but removes phones/emails", () => {
    expect(redact("See OC 128:13 from 2024-03-12")).toBe("See OC 128:13 from 2024-03-12");
    expect(redact("email me a@b.com or 917-555-1234")).toBe("email me [email] or [phone]");
  });
});
