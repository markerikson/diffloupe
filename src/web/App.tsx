import { Provider } from "react-redux";
import { store } from "./store";
import styles from "./App.module.css";

function AppContent() {
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

      {/* Main content */}
      <main className={styles.main}>
        <div className={styles.card}>
          <h2 className={styles.cardTitle}>Welcome to DiffLoupe</h2>
          <p className={styles.cardDescription}>
            Understand your diffs before you merge them.
          </p>

          {/* Severity color preview */}
          <div className={styles.severityPreview}>
            <div className={styles.severityItem}>
              <span className={styles.severityDot} data-severity="critical" />
              <span className={styles.severityLabel}>Critical</span>
            </div>
            <div className={styles.severityItem}>
              <span className={styles.severityDot} data-severity="high" />
              <span className={styles.severityLabel}>High</span>
            </div>
            <div className={styles.severityItem}>
              <span className={styles.severityDot} data-severity="medium" />
              <span className={styles.severityLabel}>Medium</span>
            </div>
            <div className={styles.severityItem}>
              <span className={styles.severityDot} data-severity="low" />
              <span className={styles.severityLabel}>Low</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export function App() {
  return (
    <Provider store={store}>
      <AppContent />
    </Provider>
  );
}
