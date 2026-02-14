import { Navigate, Route, Routes } from "react-router-dom";
import { LibraryPage } from "./pages/LibraryPage";
import { ReaderPage } from "./pages/ReaderPage";

function App() {
  return (
    <Routes>
      <Route path="/" element={<LibraryPage />} />
      <Route path="/story/:id" element={<ReaderPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default App;
