import { useState, useCallback, useEffect } from "react";
import { Provider } from "react-redux";
import { store } from "./store";
import {
  useStartAnalysisMutation,
  useGetAnalysisStatusQuery,
  type AnalysisResult,
  type AnalysisProgress,
} from "./store/api";
import { TargetSelector } from "./components/TargetSelector";
import { IntentInput } from "./components/IntentInput";
import { AnalyzeButton } from "./components/AnalyzeButton";
import { ErrorDisplay } from "./components/ErrorDisplay";
import { ResultsDisplay } from "./components/ResultsDisplay";
import { ProgressDisplay } from "./components/ProgressDisplay";
import { DiffViewer } from "./components/diff";
import { FileTree } from "./components/FileTree";
import { HighlighterProvider } from "./contexts/HighlighterContext";
import { filePathToId } from "./utils/diffStats";
import styles from "./App.module.css";

function AppContent() {
  // Form state
  const [target, setTarget] = useState("staged");
  const [statedIntent, setStatedIntent] = useState("");

  // Job state for async workflow
  const [jobId, setJobId] = useState<string | null>(null);

  // Results state (stored separately so we can clear it)
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // API mutation for starting analysis
  const [startAnalysis, { isLoading: isStarting, reset: resetStart }] =
    useStartAnalysisMutation();

  // Polling query for job status
  const {
    data: jobStatus,
    error: pollingError,
  } = useGetAnalysisStatusQuery(jobId!, {
    pollingInterval: 500,
    skip: !jobId,
  });

  // Track progress from job status
  const progress: AnalysisProgress | undefined = jobStatus?.progress;
  const isPolling = !!jobId;
  const isLoading = isStarting || isPolling;

  // Handle job completion or error
  useEffect(() => {
    if (!jobStatus) return;

    if (jobStatus.status === "complete" && jobStatus.result) {
      setResult(jobStatus.result);
      setJobId(null);
    } else if (jobStatus.status === "error") {
      setErrorMessage(jobStatus.error || "Analysis failed");
      setJobId(null);
    }
  }, [jobStatus]);

  // Handle polling errors
  useEffect(() => {
    if (pollingError) {
      const message =
        "status" in pollingError
          ? (pollingError.data as { error?: string })?.error || "Polling failed"
          : pollingError.message || "An unexpected error occurred";
      setErrorMessage(message);
      setJobId(null);
    }
  }, [pollingError]);

  const handleAnalyze = useCallback(async () => {
    // Clear previous results/errors
    setResult(null);
    setErrorMessage(null);
    resetStart();

    try {
      const response = await startAnalysis({
        target,
        statedIntent: statedIntent.trim() || undefined,
      }).unwrap();
      setJobId(response.id);
    } catch (err) {
      // Extract error message from mutation error
      const message =
        err && typeof err === "object" && "data" in err
          ? (err.data as { error?: string })?.error || "Failed to start analysis"
          : "An unexpected error occurred";
      setErrorMessage(message);
    }
  }, [startAnalysis, target, statedIntent, resetStart]);

  const handleCancel = useCallback(() => {
    setJobId(null);
    resetStart();
  }, [resetStart]);

  const handleDismissError = useCallback(() => {
    setErrorMessage(null);
  }, []);

  const handleFileClick = useCallback((path: string) => {
    const el = document.getElementById(filePathToId(path));
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const isAnalyzeDisabled = !target.trim();
  const hasFiles = result && result.diff.files.length > 0;

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

      {/* Main layout */}
      <main className={`${styles.main} ${hasFiles ? styles.withFileTree : ""}`}>
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
                onCancel={handleCancel}
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

        {/* File Tree Column */}
        {hasFiles && (
          <aside className={styles.fileTreeColumn}>
            <FileTree
              files={result.diff.files}
              onFileClick={handleFileClick}
            />
          </aside>
        )}

        {/* Center Column: Diff Viewer */}
        <section className={styles.centerColumn}>
          {result ? (
            <div className={styles.diffContainer}>
              <DiffViewer diff={result.diff} />
            </div>
          ) : isLoading ? (
            <ProgressDisplay progress={progress} />
          ) : (
            <div className={styles.placeholder}>
              <p className={styles.placeholderText}>
                Diff will appear here after analysis
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
          ) : isLoading ? (
            <ProgressDisplay progress={progress} />
          ) : (
            <div className={styles.placeholder}>
              <p className={styles.placeholderText}>
                Analysis results will appear here
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
