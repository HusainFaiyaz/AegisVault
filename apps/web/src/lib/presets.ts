/**
 * One-click sample documents for the Redaction Studio. All people,
 * organisations, identifiers and contact details are fictional; card and
 * IBAN numbers are published test values. Each preset deliberately covers
 * both detector families: NER (PER / ORG / LOC) and every regex category
 * the server-side guard rejects.
 */

export type PresetId = "hipaa-clinical" | "soc2-financial";

export interface RedactionPreset {
  id: PresetId;
  label: string;
  framework: string;
  fileName: string;
  /** Questions that make sense against this document once it is indexed. */
  suggestedQuestions: readonly string[];
  text: string;
}

export const REDACTION_PRESETS: readonly RedactionPreset[] = [
  {
    id: "hipaa-clinical",
    label: "HIPAA Clinical",
    framework: "HIPAA §164.514 Safe Harbor",
    fileName: "cardiology-discharge-summary.txt",
    suggestedQuestions: [
      "What anticoagulation plan was Daniel Reyes discharged on?",
      "Who should the patient call if symptoms return?",
    ],
    text: `Northshore Cardiology Associates — Discharge Summary

Patient: Daniel Reyes   MRN 00482913   SSN 512-48-3307
Attending: Dr. Amara Okafor   Admitted to Massachusetts General Hospital, Boston

Daniel Reyes, 58, presented with new-onset atrial fibrillation (CHA2DS2-VASc 3) and was rate-controlled with metoprolol 50 mg twice daily. Transthoracic echo showed preserved ejection fraction (55%) with mild left atrial enlargement.

Plan: start apixaban 5 mg twice daily; repeat ECG and BMP in 2 weeks at the Cambridge clinic. Dr. Amara Okafor will review Holter results.

Follow-up contact: d.okafor@northshore-cardio.org or (617) 555-0142. Billing card on file: 4111 1111 1111 1111.`,
  },
  {
    id: "soc2-financial",
    label: "SOC2 Financial",
    framework: "SOC 2 CC6.1 · Confidentiality",
    fileName: "meridian-credit-agreement-s4.txt",
    suggestedQuestions: [
      "Where are drawdown funds wired under Section 4.2?",
      "Who is the personal guarantor and what is the leverage covenant?",
    ],
    text: `Senior Secured Credit Agreement — Section 4 (Funding Mechanics)

Borrower: Meridian Freight Holdings Ltd.   Lender: Halberd Capital Partners LLP
Arranged in London; governed by the laws of England and Wales.

4.1 The Facility is a $42,500,000 term loan with a 4.25% margin over SOFR, maturing 36 months after Closing. Total Net Leverage must not exceed 3.75x, tested quarterly.

4.2 Drawdown proceeds shall be wired to the Borrower's account IBAN GB29NWBK60161331926819. Closing fees are payable by corporate card 5555 5555 5555 4444.

4.3 Eleanor Whitfield (Chief Financial Officer) signs on behalf of the Borrower. Marcus Hale provides a personal guarantee, SSN 287-65-4310.

Notices: treasury@meridianfreight.co.uk, +1 (212) 555-0187 (New York desk).`,
  },
];

export function getPreset(id: PresetId): RedactionPreset {
  const preset = REDACTION_PRESETS.find((candidate) => candidate.id === id);
  if (preset === undefined) throw new Error(`Unknown preset ${id}`);
  return preset;
}
