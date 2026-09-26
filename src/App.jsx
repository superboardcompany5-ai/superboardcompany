import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import ProtectedRoute from './components/ProtectedRoute'
import NavBar from './components/NavBar'
import Login from './pages/Login'
import ReelStock from './pages/ReelStock'
import ReelReceipts from './pages/ReelReceipts'
import ReelJobCards from './pages/ReelJobCards'
import ReelDispatches from './pages/ReelDispatches'

function Layout({ children }) {
  return (
    <>
      <NavBar />
      <main>{children}</main>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<ProtectedRoute><Layout><ReelStock /></Layout></ProtectedRoute>} />
        <Route path="/reel-receipts" element={<ProtectedRoute><Layout><ReelReceipts /></Layout></ProtectedRoute>} />
        <Route path="/reel-job-cards" element={<ProtectedRoute><Layout><ReelJobCards /></Layout></ProtectedRoute>} />
        <Route path="/reel-dispatches" element={<ProtectedRoute><Layout><ReelDispatches /></Layout></ProtectedRoute>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
