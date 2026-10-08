import { Provider } from "react-redux";
import { store } from "./store";
import styles from "./App.module.css";

function AppContent() {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <div className={styles.headerContent}>
          <h1 className={styles.title}>
            <span className={styles.titleAccent}>Diff</span>
            <span className={styles.titleSecondary}>Loupe</span>
          </h1>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.placeholder}>
          <p className={styles.placeholderText}>
            The review UI is not built yet. Use <code>diffloupe review --headless</code>.
          </p>
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
