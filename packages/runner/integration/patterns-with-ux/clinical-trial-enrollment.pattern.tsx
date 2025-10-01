/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  Default,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

const toTitleCase = (value: string): string => {
  return value
    .toLowerCase()
    .split(/\s+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
};

const sanitizeText = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const sanitizeId = (value: unknown): string | null => {
  const text = sanitizeText(value);
  return text ? text.toUpperCase() : null;
};

const clampNumber = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const clamped = Math.min(Math.max(value, min), max);
  return Math.round(clamped);
};

const sanitizeCondition = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "Any";
  return toTitleCase(text);
};

const sanitizeSite = (value: unknown): string => {
  const text = sanitizeText(value);
  if (!text) return "Unassigned";
  return toTitleCase(text);
};

interface CandidateLike {
  id?: string;
  candidateId?: string;
  age?: number;
  condition?: string;
  consentGiven?: boolean;
  biomarkerScore?: number;
  site?: string;
  priorTherapy?: boolean;
}

interface TrialCandidate {
  id: string;
  age: number;
  condition: string;
  consentGiven: boolean;
  biomarkerScore: number;
  site: string;
  priorTherapy: boolean;
}

const sanitizeCandidateEntry = (
  value: CandidateLike | undefined,
): TrialCandidate | null => {
  const id = sanitizeId(value?.id ?? value?.candidateId);
  if (!id) return null;
  const age = clampNumber(value?.age, 18, 90, 18);
  const condition = sanitizeCondition(value?.condition);
  const biomarker = clampNumber(value?.biomarkerScore, 0, 100, 0);
  const consent = Boolean(value?.consentGiven);
  const site = sanitizeSite(value?.site);
  const priorTherapy = Boolean(value?.priorTherapy);
  return {
    id,
    age,
    condition,
    consentGiven: consent,
    biomarkerScore: biomarker,
    site,
    priorTherapy,
  };
};

const defaultCandidates: TrialCandidate[] = [
  {
    id: "P-001",
    age: 45,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 67,
    site: "North Campus",
    priorTherapy: false,
  },
  {
    id: "P-002",
    age: 52,
    condition: "Diabetes",
    consentGiven: false,
    biomarkerScore: 71,
    site: "North Campus",
    priorTherapy: false,
  },
  {
    id: "P-003",
    age: 29,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 58,
    site: "West Clinic",
    priorTherapy: true,
  },
  {
    id: "P-004",
    age: 62,
    condition: "Hypertension",
    consentGiven: true,
    biomarkerScore: 82,
    site: "East Facility",
    priorTherapy: false,
  },
];

const sanitizeCandidates = (
  value: readonly CandidateLike[] | undefined,
): TrialCandidate[] => {
  if (!Array.isArray(value)) {
    return defaultCandidates.map((candidate) => ({ ...candidate }));
  }
  const map = new Map<string, TrialCandidate>();
  for (const entry of value) {
    const sanitized = sanitizeCandidateEntry(entry);
    if (!sanitized) continue;
    map.set(sanitized.id, sanitized);
  }
  if (map.size === 0) {
    return defaultCandidates.map((candidate) => ({ ...candidate }));
  }
  const list = Array.from(map.values());
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list;
};

interface EnrollmentCriteria {
  minAge: number;
  maxAge: number;
  requiredCondition: string | null;
  minBiomarkerScore: number;
  requireConsent: boolean;
  allowedSites: string[];
  allowPriorTherapy: boolean;
}

const defaultCriteria: EnrollmentCriteria = {
  minAge: 30,
  maxAge: 70,
  requiredCondition: "Hypertension",
  minBiomarkerScore: 60,
  requireConsent: true,
  allowedSites: [],
  allowPriorTherapy: false,
};

const sanitizeAllowedSites = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const sites = new Set<string>();
  for (const entry of value) {
    const text = sanitizeText(entry);
    if (!text) continue;
    sites.add(toTitleCase(text));
  }
  return Array.from(sites).sort((a, b) => a.localeCompare(b));
};

const sanitizeCriteria = (
  value: Partial<EnrollmentCriteria> | undefined,
): EnrollmentCriteria => {
  const minAge = clampNumber(value?.minAge, 18, 90, defaultCriteria.minAge);
  const maxAge = clampNumber(value?.maxAge, minAge, 95, defaultCriteria.maxAge);
  const requiredCondition = value?.requiredCondition === null
    ? null
    : value?.requiredCondition === undefined
    ? defaultCriteria.requiredCondition
    : sanitizeCondition(value.requiredCondition);
  const minBiomarkerScore = clampNumber(
    value?.minBiomarkerScore,
    0,
    100,
    defaultCriteria.minBiomarkerScore,
  );
  return {
    minAge,
    maxAge,
    requiredCondition,
    minBiomarkerScore,
    requireConsent: Boolean(
      value?.requireConsent ?? defaultCriteria.requireConsent,
    ),
    allowedSites: sanitizeAllowedSites(value?.allowedSites),
    allowPriorTherapy: Boolean(
      value?.allowPriorTherapy ?? defaultCriteria.allowPriorTherapy,
    ),
  };
};

interface CriteriaPatch {
  minAge?: number;
  maxAge?: number;
  requiredCondition?: string | null;
  minBiomarkerScore?: number;
  requireConsent?: boolean;
  allowedSites?: string[];
  allowPriorTherapy?: boolean;
}

const sanitizeCriteriaPatch = (
  value: CriteriaPatch | undefined,
): Partial<EnrollmentCriteria> | null => {
  if (value === undefined || value === null) return null;
  const patch: Partial<EnrollmentCriteria> = {};
  if (value.minAge !== undefined) patch.minAge = value.minAge;
  if (value.maxAge !== undefined) patch.maxAge = value.maxAge;
  if (value.requiredCondition !== undefined) {
    patch.requiredCondition = value.requiredCondition === null
      ? null
      : sanitizeCondition(value.requiredCondition);
  }
  if (value.minBiomarkerScore !== undefined) {
    patch.minBiomarkerScore = value.minBiomarkerScore;
  }
  if (value.requireConsent !== undefined) {
    patch.requireConsent = Boolean(value.requireConsent);
  }
  if (value.allowedSites !== undefined) {
    patch.allowedSites = sanitizeAllowedSites(value.allowedSites);
  }
  if (value.allowPriorTherapy !== undefined) {
    patch.allowPriorTherapy = Boolean(value.allowPriorTherapy);
  }
  return Object.keys(patch).length > 0 ? patch : null;
};

interface CandidatePatch {
  id?: string;
  candidateId?: string;
  age?: number;
  condition?: string;
  consentGiven?: boolean;
  biomarkerScore?: number;
  site?: string;
  priorTherapy?: boolean;
}

const sanitizeCandidatePatch = (
  value: CandidatePatch | undefined,
): { id: string; updates: CandidateLike } | null => {
  const id = sanitizeId(value?.id ?? value?.candidateId);
  if (!id) return null;
  const updates: CandidateLike = { id };
  if (value?.age !== undefined) updates.age = value.age;
  if (value?.condition !== undefined) updates.condition = value.condition;
  if (value?.consentGiven !== undefined) {
    updates.consentGiven = Boolean(value.consentGiven);
  }
  if (value?.biomarkerScore !== undefined) {
    updates.biomarkerScore = value.biomarkerScore;
  }
  if (value?.site !== undefined) updates.site = value.site;
  if (value?.priorTherapy !== undefined) {
    updates.priorTherapy = Boolean(value.priorTherapy);
  }
  return { id, updates };
};

interface ScreeningResult {
  candidate: TrialCandidate;
  eligible: boolean;
  reasons: string[];
}

const buildScreeningReport = (
  candidates: readonly TrialCandidate[],
  criteria: EnrollmentCriteria,
): ScreeningResult[] => {
  const results: ScreeningResult[] = [];
  const allowedSites = criteria.allowedSites;
  const requireSiteMatch = allowedSites.length > 0;
  for (const candidate of candidates) {
    const reasons: string[] = [];
    if (candidate.age < criteria.minAge) {
      reasons.push("below minimum age");
    } else if (candidate.age > criteria.maxAge) {
      reasons.push("above maximum age");
    }
    if (
      criteria.requiredCondition &&
      candidate.condition !== criteria.requiredCondition
    ) {
      reasons.push("condition mismatch");
    }
    if (candidate.biomarkerScore < criteria.minBiomarkerScore) {
      reasons.push("biomarker below threshold");
    }
    if (criteria.requireConsent && !candidate.consentGiven) {
      reasons.push("consent pending");
    }
    if (!criteria.allowPriorTherapy && candidate.priorTherapy) {
      reasons.push("previous therapy excluded");
    }
    if (
      requireSiteMatch &&
      !allowedSites.includes(candidate.site)
    ) {
      reasons.push("site not approved");
    }
    results.push({ candidate, eligible: reasons.length === 0, reasons });
  }
  results.sort((a, b) => a.candidate.id.localeCompare(b.candidate.id));
  return results;
};

interface SiteSummaryEntry {
  site: string;
  eligible: number;
  total: number;
  eligibleRatio: number;
}

const buildSiteSummary = (
  report: readonly ScreeningResult[],
): SiteSummaryEntry[] => {
  const totals = new Map<string, { eligible: number; total: number }>();
  for (const entry of report) {
    const site = entry.candidate.site;
    const current = totals.get(site) ?? { eligible: 0, total: 0 };
    const eligible = entry.eligible ? current.eligible + 1 : current.eligible;
    totals.set(site, { eligible, total: current.total + 1 });
  }
  const summary: SiteSummaryEntry[] = [];
  for (const [site, counts] of totals.entries()) {
    const ratio = counts.total === 0
      ? 0
      : Math.round((counts.eligible / counts.total) * 100) / 100;
    summary.push({
      site,
      eligible: counts.eligible,
      total: counts.total,
      eligibleRatio: ratio,
    });
  }
  summary.sort((a, b) => a.site.localeCompare(b.site));
  return summary;
};

interface ClinicalTrialEnrollmentArgs {
  participants: Default<TrialCandidate[], typeof defaultCandidates>;
  criteria: Default<EnrollmentCriteria, typeof defaultCriteria>;
}

export const clinicalTrialEnrollmentUx = recipe<ClinicalTrialEnrollmentArgs>(
  "Clinical Trial Enrollment (UX)",
  ({ participants, criteria }) => {
    const candidateView = lift(sanitizeCandidates)(participants);
    const criteriaView = lift(sanitizeCriteria)(criteria);

    const screening = lift(({ candid, crit }) =>
      buildScreeningReport(candid, crit)
    )({
      candid: candidateView,
      crit: criteriaView,
    });

    const eligibleCandidates = lift((report: ScreeningResult[]) =>
      report.filter((entry) => entry.eligible).map((entry) => entry.candidate)
    )(screening);

    const ineligibleReport = lift((report: ScreeningResult[]) =>
      report
        .filter((entry) => !entry.eligible)
        .map((entry) => ({
          id: entry.candidate.id,
          reasons: entry.reasons,
        }))
    )(screening);

    const eligibleIds = lift((list: readonly TrialCandidate[]) =>
      list.map((candidate) => candidate.id)
    )(eligibleCandidates);

    const candidateCount = lift((list: readonly TrialCandidate[]) =>
      list.length
    )(candidateView);

    const eligibleCount = lift((ids: readonly string[]) => ids.length)(
      eligibleIds,
    );

    const eligibleSummary =
      str`${eligibleCount} of ${candidateCount} participants eligible`;

    const siteSummary = lift((report: ScreeningResult[]) =>
      buildSiteSummary(report)
    )(screening);

    const selectedCandidateId = cell<string>("");
    const consentToggle = cell<boolean>(true);

    const updateConsent = handler<
      unknown,
      {
        participants: Cell<CandidateLike[]>;
        candidateId: Cell<string>;
        consent: Cell<boolean>;
      }
    >((_event, { participants, candidateId, consent }) => {
      const id = sanitizeId(candidateId.get());
      if (!id) return;
      const current = sanitizeCandidates(participants.get());
      const index = current.findIndex((candidate) => candidate.id === id);
      if (index === -1) return;
      const merged = sanitizeCandidateEntry({
        ...current[index],
        consentGiven: consent.get(),
      });
      if (!merged) return;
      const next = current.slice();
      next[index] = merged;
      participants.set(sanitizeCandidates(next));
    })({
      participants,
      candidateId: selectedCandidateId,
      consent: consentToggle,
    });

    const name =
      str`Clinical Trial (${eligibleCount}/${candidateCount} eligible)`;

    const eligibilityRate = lift(
      (input: { eligible: number; total: number }) => {
        if (input.total === 0) return 0;
        return Math.round((input.eligible / input.total) * 100);
      },
    )({ eligible: eligibleCount, total: candidateCount });

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 64rem;
            background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%);
            padding: 1.5rem;
            border-radius: 1rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #0369a1;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                    font-weight: 600;
                  ">
                  Clinical Research
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.5rem;
                    color: #0c4a6e;
                    font-weight: 700;
                  ">
                  Trial Enrollment Screening
                </h2>
                <p style="
                    margin: 0;
                    font-size: 0.9rem;
                    color: #475569;
                  ">
                  Evaluate participant eligibility against enrollment criteria
                </p>
              </div>

              <div style="
                  background: linear-gradient(135deg, #0ea5e9 0%, #0284c7 100%);
                  border-radius: 0.75rem;
                  padding: 1.25rem;
                  color: white;
                  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                    margin-bottom: 0.75rem;
                  ">
                  <span style="font-size: 0.85rem; opacity: 0.95;">
                    Eligibility Rate
                  </span>
                  <strong style="font-size: 2rem; font-weight: 700;">
                    {eligibilityRate}%
                  </strong>
                </div>

                <div style="
                    position: relative;
                    height: 0.75rem;
                    background: rgba(255, 255, 255, 0.2);
                    border-radius: 0.375rem;
                    overflow: hidden;
                  ">
                  <div
                    style={lift(
                      (pct: number) =>
                        `position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; background: white; border-radius: 0.375rem; transition: width 0.3s ease;`,
                    )(eligibilityRate)}
                  >
                  </div>
                </div>

                <div style="
                    margin-top: 0.75rem;
                    font-size: 0.85rem;
                    opacity: 0.9;
                  ">
                  {eligibleSummary}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1.1rem; color: #0c4a6e;">
                Enrollment Criteria
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                gap: 1rem;
              "
            >
              <div style="
                  background: #f0f9ff;
                  border-left: 3px solid #0ea5e9;
                  border-radius: 0.375rem;
                  padding: 0.875rem;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #0369a1;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                  ">
                  Age Range
                </div>
                <div style="font-size: 1.25rem; font-weight: 600; color: #0c4a6e;">
                  {lift((crit) => crit.minAge)(criteriaView)} -{" "}
                  {lift((crit) => crit.maxAge)(criteriaView)}
                </div>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 3px solid #0ea5e9;
                  border-radius: 0.375rem;
                  padding: 0.875rem;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #0369a1;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                  ">
                  Condition
                </div>
                <div style="font-size: 1.25rem; font-weight: 600; color: #0c4a6e;">
                  {lift((crit) => crit.requiredCondition ?? "Any")(
                    criteriaView,
                  )}
                </div>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 3px solid #0ea5e9;
                  border-radius: 0.375rem;
                  padding: 0.875rem;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #0369a1;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                  ">
                  Min Biomarker
                </div>
                <div style="font-size: 1.25rem; font-weight: 600; color: #0c4a6e;">
                  {lift((crit) => crit.minBiomarkerScore)(criteriaView)}
                </div>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 3px solid #0ea5e9;
                  border-radius: 0.375rem;
                  padding: 0.875rem;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #0369a1;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                  ">
                  Consent Required
                </div>
                <div style="font-size: 1.25rem; font-weight: 600; color: #0c4a6e;">
                  {lift((crit) => (crit.requireConsent ? "Yes" : "No"))(
                    criteriaView,
                  )}
                </div>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 3px solid #0ea5e9;
                  border-radius: 0.375rem;
                  padding: 0.875rem;
                ">
                <div style="
                    font-size: 0.75rem;
                    color: #0369a1;
                    text-transform: uppercase;
                    letter-spacing: 0.05em;
                    margin-bottom: 0.25rem;
                  ">
                  Prior Therapy
                </div>
                <div style="font-size: 1.25rem; font-weight: 600; color: #0c4a6e;">
                  {lift((
                    crit,
                  ) => (crit.allowPriorTherapy ? "Allowed" : "Excluded"))(
                    criteriaView,
                  )}
                </div>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1.1rem; color: #0c4a6e;">
                Screening Results
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
                max-height: 500px;
                overflow-y: auto;
              "
            >
              {lift((results: ScreeningResult[]) =>
                results.map((result) => (
                  <div
                    style={`
                      background: ${result.eligible ? "#f0fdf4" : "#fef2f2"};
                      border-left: 4px solid ${
                      result.eligible ? "#10b981" : "#ef4444"
                    };
                      border-radius: 0.5rem;
                      padding: 1rem;
                    `}
                  >
                    <div style="
                        display: flex;
                        justify-content: space-between;
                        align-items: start;
                        margin-bottom: 0.5rem;
                      ">
                      <div>
                        <div style="
                            font-weight: 700;
                            font-size: 1.1rem;
                            color: #0f172a;
                          ">
                          {result.candidate.id}
                        </div>
                        <div style="
                            font-size: 0.85rem;
                            color: #64748b;
                            margin-top: 0.125rem;
                          ">
                          {result.candidate.condition} • Age {result.candidate
                            .age} • {result.candidate.site}
                        </div>
                      </div>
                      <span
                        style={`
                          font-weight: 600;
                          font-size: 0.8rem;
                          padding: 0.25rem 0.75rem;
                          border-radius: 0.375rem;
                          background: ${
                          result.eligible ? "#10b981" : "#ef4444"
                        };
                          color: white;
                        `}
                      >
                        {result.eligible ? "ELIGIBLE" : "INELIGIBLE"}
                      </span>
                    </div>

                    <div style="
                        display: grid;
                        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
                        gap: 0.5rem;
                        font-size: 0.8rem;
                        color: #475569;
                        margin-top: 0.5rem;
                      ">
                      <div>
                        Consent:{" "}
                        {result.candidate.consentGiven
                          ? "✓ Given"
                          : "✗ Pending"}
                      </div>
                      <div>
                        Biomarker: {result.candidate.biomarkerScore}
                      </div>
                      <div>
                        Prior Therapy:{" "}
                        {result.candidate.priorTherapy ? "Yes" : "No"}
                      </div>
                    </div>

                    {!result.eligible && result.reasons.length > 0
                      ? (
                        <div style="
                          margin-top: 0.75rem;
                          padding-top: 0.75rem;
                          border-top: 1px solid #fca5a5;
                        ">
                          <div style="
                            font-size: 0.75rem;
                            color: #b91c1c;
                            font-weight: 600;
                            margin-bottom: 0.25rem;
                          ">
                            Exclusion Reasons:
                          </div>
                          <div style="
                            font-size: 0.8rem;
                            color: #dc2626;
                          ">
                            {result.reasons.join(", ")}
                          </div>
                        </div>
                      )
                      : null}
                  </div>
                ))
              )(screening)}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1.1rem; color: #0c4a6e;">
                Site Summary
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
                gap: 1rem;
              "
            >
              {lift((summary: SiteSummaryEntry[]) =>
                summary.map((entry) => (
                  <div style="
                      background: #f8fafc;
                      border: 2px solid #e2e8f0;
                      border-radius: 0.5rem;
                      padding: 1rem;
                    ">
                    <div style="
                        font-weight: 600;
                        font-size: 1rem;
                        color: #0f172a;
                        margin-bottom: 0.5rem;
                      ">
                      {entry.site}
                    </div>
                    <div style="
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 0.5rem;
                      ">
                      <span style="font-size: 0.85rem; color: #64748b;">
                        Eligible / Total
                      </span>
                      <span style="
                          font-size: 1.25rem;
                          font-weight: 700;
                          color: #0c4a6e;
                        ">
                        {entry.eligible} / {entry.total}
                      </span>
                    </div>
                    <div style="
                        position: relative;
                        height: 0.5rem;
                        background: #e2e8f0;
                        border-radius: 0.25rem;
                        overflow: hidden;
                      ">
                      <div
                        style={`
                          position: absolute;
                          left: 0;
                          top: 0;
                          bottom: 0;
                          width: ${(entry.eligibleRatio * 100).toFixed(0)}%;
                          background: linear-gradient(90deg, #10b981, #0ea5e9);
                          border-radius: 0.25rem;
                          transition: width 0.3s ease;
                        `}
                      >
                      </div>
                    </div>
                    <div style="
                        margin-top: 0.5rem;
                        font-size: 0.75rem;
                        color: #64748b;
                        text-align: right;
                      ">
                      {(entry.eligibleRatio * 100).toFixed(0)}% eligible
                    </div>
                  </div>
                ))
              )(siteSummary)}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1.1rem; color: #0c4a6e;">
                Update Participant Consent
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1rem;
              "
            >
              <div style="display: flex; flex-direction: column; gap: 0.4rem;">
                <label
                  for="candidate-id"
                  style="font-size: 0.85rem; font-weight: 500; color: #334155;"
                >
                  Participant ID
                </label>
                <ct-input
                  id="candidate-id"
                  $value={selectedCandidateId}
                  placeholder="e.g., P-001"
                  aria-label="Enter participant ID"
                >
                </ct-input>
              </div>

              <div style="
                  display: flex;
                  align-items: center;
                  gap: 0.75rem;
                ">
                <label style="
                    display: flex;
                    align-items: center;
                    gap: 0.5rem;
                    cursor: pointer;
                  ">
                  <input
                    type="checkbox"
                    checked={lift((c: boolean) => c)(consentToggle)}
                    onChange={handler<
                      Event,
                      { consent: Cell<boolean> }
                    >((event, { consent }) => {
                      const target = event.target as HTMLInputElement;
                      consent.set(target.checked);
                    })({ consent: consentToggle })}
                    style="
                      width: 1.25rem;
                      height: 1.25rem;
                      cursor: pointer;
                    "
                  />
                  <span style="font-size: 0.9rem; color: #334155;">
                    Consent Given
                  </span>
                </label>
              </div>

              <ct-button onClick={updateConsent}>
                Update Consent Status
              </ct-button>
            </div>
          </ct-card>
        </div>
      ),
      candidates: candidateView,
      criteria: criteriaView,
      screening,
      eligibleCandidates,
      eligibleIds,
      eligibleCount,
      eligibleSummary,
      ineligibleReport,
      siteSummary,
    };
  },
);

export default clinicalTrialEnrollmentUx;

export type {
  ClinicalTrialEnrollmentArgs,
  EnrollmentCriteria,
  ScreeningResult,
  SiteSummaryEntry,
  TrialCandidate,
};
