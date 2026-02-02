/**
 * ResultsDisplay - Shows analysis results (basic JSON display for now)
 */

import type { AnalysisResult } from "../store/api";
import styles from "./ResultsDisplay.module.css";

export interface ResultsDisplayProps {
  result: AnalysisResult;
}

export function ResultsDisplay({ result }: ResultsDisplayProps) {
  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Analysis Results</h3>
      
      {/* Intent Section */}
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>Derived Intent</h4>
        <p className={styles.summary}>{result.derivedIntent.summary}</p>
        <div className={styles.meta}>
          <span className={styles.tag} data-type="scope">
            {result.derivedIntent.scope}
          </span>
          {result.derivedIntent.affectedAreas.map((area) => (
            <span key={area} className={styles.tag}>
              {area}
            </span>
          ))}
        </div>
      </section>

      {/* Risks Section */}
      <section className={styles.section}>
        <h4 className={styles.sectionTitle}>
          Risk Assessment
          <span className={styles.riskLevel} data-level={result.risks.overallRisk}>
            {result.risks.overallRisk}
          </span>
        </h4>
        <p className={styles.summary}>{result.risks.summary}</p>
        
        {result.risks.risks.length > 0 && (
          <ul className={styles.riskList}>
            {result.risks.risks.map((risk, i) => (
              <li key={i} className={styles.riskItem} data-severity={risk.severity}>
                <span className={styles.riskSeverity}>{risk.severity}</span>
                <span className={styles.riskCategory}>{risk.category}</span>
                <p className={styles.riskDescription}>{risk.description}</p>
                {risk.file && (
                  <span className={styles.riskFile}>{risk.file}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Alignment Section (if present) */}
      {result.alignment && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>
            Intent Alignment
            <span
              className={styles.alignmentScore}
              data-aligned={result.alignment.alignment === "aligned"}
            >
              {result.alignment.alignment === "aligned"
                ? "Aligned"
                : result.alignment.alignment === "partial"
                  ? "Partial"
                  : "Misaligned"}
            </span>
          </h4>
          <p className={styles.summary}>{result.alignment.summary}</p>

          {result.alignment.matches.length > 0 && (
            <div className={styles.alignmentList}>
              <strong>Matches:</strong>
              <ul>
                {result.alignment.matches.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {result.alignment.mismatches.length > 0 && (
            <div className={styles.alignmentList} data-type="warning">
              <strong>Mismatches:</strong>
              <ul>
                {result.alignment.mismatches.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {result.alignment.missing.length > 0 && (
            <div className={styles.alignmentList} data-type="warning">
              <strong>Missing (stated but not implemented):</strong>
              <ul>
                {result.alignment.missing.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}

          {result.alignment.unstated.length > 0 && (
            <div className={styles.alignmentList} data-type="info">
              <strong>Unstated (implemented but not mentioned):</strong>
              <ul>
                {result.alignment.unstated.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}

      {/* Raw JSON fallback for debugging */}
      <details className={styles.rawJson}>
        <summary>Raw JSON</summary>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </details>
    </div>
  );
}
