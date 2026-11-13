import type { EntityCategory } from "@aegis/shared";

export interface EntityStyle {
  label: string;
  /** Pill colours: background, text, ring. */
  className: string;
  /** Small solid swatch for legends. */
  swatch: string;
}

/**
 * One hue per family so a glance tells identity (people, orgs, places) from
 * regulated identifiers (health, government, financial, contact).
 */
export const ENTITY_STYLES: Readonly<Record<EntityCategory, EntityStyle>> = {
  PER: { label: "Person", className: "bg-sky-50 text-sky-900 ring-sky-300", swatch: "bg-sky-500" },
  ORG: { label: "Organisation", className: "bg-violet-50 text-violet-900 ring-violet-300", swatch: "bg-violet-500" },
  LOC: { label: "Location", className: "bg-teal-50 text-teal-900 ring-teal-300", swatch: "bg-teal-500" },
  SSN: { label: "SSN", className: "bg-rose-50 text-rose-900 ring-rose-300", swatch: "bg-rose-500" },
  MRN: { label: "Medical record no.", className: "bg-rose-50 text-rose-900 ring-rose-300", swatch: "bg-rose-400" },
  IBAN: { label: "IBAN", className: "bg-amber-50 text-amber-900 ring-amber-300", swatch: "bg-amber-500" },
  CREDIT_CARD: { label: "Card number", className: "bg-amber-50 text-amber-900 ring-amber-300", swatch: "bg-amber-400" },
  EMAIL: { label: "Email", className: "bg-indigo-50 text-indigo-900 ring-indigo-300", swatch: "bg-indigo-500" },
  PHONE: { label: "Phone", className: "bg-indigo-50 text-indigo-900 ring-indigo-300", swatch: "bg-indigo-400" },
};

export const UNRESOLVED_STYLE = "bg-stone-100 text-stone-600 ring-stone-300";
