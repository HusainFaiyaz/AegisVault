import { describe, expect, it } from "vitest";

import {
  detectRawPiiLeakage,
  hasRawPiiLeakage,
} from "../guards/pii-leakage.guard.js";

describe("detectRawPiiLeakage", () => {
  it("flags a raw SSN", () => {
    const findings = detectRawPiiLeakage("Patient SSN is 123-45-6789.");
    expect(findings.some((f) => f.category === "SSN")).toBe(true);
  });

  it("flags a raw MRN", () => {
    const findings = detectRawPiiLeakage("Chart ref MRN:1234567 on file.");
    expect(findings.some((f) => f.category === "MRN")).toBe(true);
  });

  it("flags a raw MRN case-insensitively", () => {
    const findings = detectRawPiiLeakage("see mrn-7654321 for history");
    expect(findings.some((f) => f.category === "MRN")).toBe(true);
  });

  it("flags a raw IBAN", () => {
    const findings = detectRawPiiLeakage(
      "Wire funds to GB29NWBK60161331926819 today.",
    );
    expect(findings.some((f) => f.category === "IBAN")).toBe(true);
  });

  it("flags a raw credit card number", () => {
    const findings = detectRawPiiLeakage("Card on file: 4111 1111 1111 1111");
    expect(findings.some((f) => f.category === "CREDIT_CARD")).toBe(true);
  });

  it("flags a raw email address", () => {
    const findings = detectRawPiiLeakage("Contact john.doe@example.com now.");
    expect(findings.some((f) => f.category === "EMAIL")).toBe(true);
  });

  it("flags a raw phone number", () => {
    const findings = detectRawPiiLeakage("Call the patient at 415-555-0199.");
    expect(findings.some((f) => f.category === "PHONE")).toBe(true);
  });

  it("permits a [PER_89A1] placeholder without flagging it", () => {
    const findings = detectRawPiiLeakage("Patient [PER_89A1] is stable.");
    expect(findings).toHaveLength(0);
  });

  it("permits a [MRN_3F90] placeholder without flagging it", () => {
    const findings = detectRawPiiLeakage("Record [MRN_3F90] was reviewed.");
    expect(findings).toHaveLength(0);
  });

  it("permits a [SSN_1A2B] placeholder without flagging it", () => {
    const findings = detectRawPiiLeakage("Identifier [SSN_1A2B] on file.");
    expect(findings).toHaveLength(0);
  });

  it("permits multiple mixed placeholders in the same string", () => {
    const findings = detectRawPiiLeakage(
      "[PER_89A1] was seen regarding [MRN_3F90] and billed via [CREDIT_CARD_00FF].",
    );
    expect(findings).toHaveLength(0);
  });

  it("returns an empty array for clean, PII-free text", () => {
    const findings = detectRawPiiLeakage(
      "The cardiology protocol was updated this quarter.",
    );
    expect(findings).toEqual([]);
  });

  it("still catches raw PII alongside legitimate placeholders", () => {
    const findings = detectRawPiiLeakage(
      "[PER_89A1] can be reached at jane.smith@example.com.",
    );
    expect(findings.some((f) => f.category === "EMAIL")).toBe(true);
  });

  it("finds every raw PII instance in a multi-entity string", () => {
    const findings = detectRawPiiLeakage(
      "SSN 123-45-6789 and email test@example.com and phone 415-555-0199.",
    );
    const categories = findings.map((f) => f.category).sort();
    expect(categories).toEqual(["EMAIL", "PHONE", "SSN"]);
  });

  it("hasRawPiiLeakage returns true when raw PII is present", () => {
    expect(hasRawPiiLeakage("SSN is 123-45-6789")).toBe(true);
  });

  it("hasRawPiiLeakage returns false for placeholder-only text", () => {
    expect(hasRawPiiLeakage("[PER_89A1] is stable")).toBe(false);
  });

  it("hasRawPiiLeakage returns false for clean text", () => {
    expect(hasRawPiiLeakage("Quarterly review completed on schedule.")).toBe(
      false,
    );
  });
});
