import { NavLink } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

export default function NavBar() {
  const { signOut } = useAuth()

  return (
    <nav className="navbar">
      <NavLink to="/" end>Reel Stock</NavLink>
      <NavLink to="/reel-receipts">Reel Receipts</NavLink>
      <NavLink to="/reel-dispatches">Reel Dispatches</NavLink>
      <button className="link-button" onClick={signOut}>Log out</button>
    </nav>
  )
}
