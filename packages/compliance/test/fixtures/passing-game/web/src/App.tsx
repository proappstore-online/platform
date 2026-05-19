import { GameShell } from '@proappstore/games';
import './index.css';
import { Footer } from './Footer.js';

export default function App() {
  return (
    <GameShell>
      <h1>Passing Game</h1>
      <Footer />
    </GameShell>
  );
}
