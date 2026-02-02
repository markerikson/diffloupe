import { useState, useCallback } from "react";
import { Provider } from "react-redux";
import { store } from "./store";
import { useAnalyzeSyncMutation, type AnalysisResult } from "./store/api";
import { TargetSelector } from "./components/TargetSelector";
import { IntentInput } from "./components/IntentInput";
import { AnalyzeButton } from "./components/AnalyzeButton";
import { ErrorDisplay } from "./components/ErrorDisplay";
import { ResultsDisplay } from "./components/ResultsDisplay";
import { DiffViewer } from "./components/diff";
import { HighlighterProvider } from "./contexts/HighlighterContext";
import styles from "./App.module.css";

function AppContent() {
  // Form state
  const [target, setTarget] = useState("staged");
  const [statedIntent, setStatedIntent] = useState("");

  // API mutation
  const [analyzeSync, { isLoading, error, reset }] = useAnalyzeSyncMutation();

  // Results state (stored separately so we can clear it)
  const [result, setResult] = useState<AnalysisResult | null>(null);

  const handleAnalyze = useCallback(async () => {
    // Clear previous results/errors
    setResult(null);
    reset();

    try {
      const response = await analyzeSync({
        target,
        statedIntent: statedIntent.trim() || undefined,
      }).unwrap();
      setResult(response);
    } catch {
      // Error is handled by RTK Query and displayed via the error state
    }
  }, [analyzeSync, target, statedIntent, reset]);

  const handleDismissError = useCallback(() => {
    reset();
  }, [reset]);

  // Extract error message from RTK Query error
  const errorMessage = error
    ? "status" in error
      ? (error.data as { error?: string })?.error || "Analysis failed"
      : error.message || "An unexpected error occurred"
    : null;

  const isAnalyzeDisabled = !target.trim();

  return (
    <div className={styles.container}>
      {/* Header */}
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <h1 className={styles.title}>
            <span className={styles.titleAccent}>Diff</span>
            <span className={styles.titleSecondary}>Loupe</span>
          </h1>
        </div>
      </header>

      {/* Main 3-column layout */}
      <main className={styles.main}>
        {/* Left Column: Input Section */}
        <aside className={styles.leftColumn}>
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>Analyze Changes</h2>
            <p className={styles.cardDescription}>
              Select a diff target and optionally describe your intent.
            </p>

            <div className={styles.formSection}>
              <TargetSelector
                value={target}
                onChange={setTarget}
                disabled={isLoading}
              />
            </div>

            <div className={styles.formSection}>
              <IntentInput
                value={statedIntent}
                onChange={setStatedIntent}
                disabled={isLoading}
              />
            </div>

            <div className={styles.actionSection}>
              <AnalyzeButton
                onClick={handleAnalyze}
                disabled={isAnalyzeDisabled}
                isLoading={isLoading}
              />
            </div>

            {/* Error display */}
            {errorMessage && (
              <div className={styles.errorSection}>
                <ErrorDisplay
                  error={errorMessage}
                  onDismiss={handleDismissError}
                />
              </div>
            )}
          </div>
        </aside>

        {/* Center Column: Diff Viewer */}
        <section className={styles.centerColumn}>
          {result ? (
            <div className={styles.diffContainer}>
              <DiffViewer diff={result.diff} />
            </div>
          ) : (
            <div className={styles.placeholder}>
              <p className={styles.placeholderText}>
                {isLoading
                  ? "Analyzing changes..."
                  : "Diff will appear here after analysis"}
              </p>
            </div>
          )}
        </section>

        {/* Right Column: Analysis Results */}
        <aside className={styles.rightColumn}>
          {result ? (
            <div className={styles.card}>
              <ResultsDisplay result={result} />
            </div>
          ) : (
            <div className={styles.placeholder}>
              <p className={styles.placeholderText}>
                {isLoading
                  ? "Running analysis..."
                  : "Analysis results will appear here"}
              </p>
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}

export function App() {
  return (
    <Provider store={store}>
      <HighlighterProvider>
        <AppContent />
      </HighlighterProvider>
    </Provider>
  );
}
