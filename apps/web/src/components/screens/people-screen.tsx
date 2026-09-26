import { ArrowRight, Plus } from 'lucide-react';
import type { Dashboard, Person } from '@tallie/db/contracts';
import { money } from '@/lib/client';
import { Avatar, Button } from '../ui';

interface PeopleScreenProps {
  data: Dashboard;
  onNewSplit: () => void;
  onSelectPerson: (person: Person) => void;
}
export function PeopleScreen({ data, onNewSplit, onSelectPerson }: PeopleScreenProps) {
  return (
    <>
      <section className="page-heading">
        <div>
          <p className="greeting">The best part of every plan.</p>
          <h1>
            Your kind of <em>people.</em>
          </h1>
        </div>
        <Button onClick={() => onNewSplit()}>
          <Plus size={18} />
          Start a split
        </Button>
      </section>
      <div className="people-grid">
        {data.people
          .filter((p) => p.id !== data.user.id)
          .map((friend) => {
            const balance = data.personBalances.find((entry) => entry.personId === friend.id);
            const owed = BigInt(balance?.owedToYouMinor ?? '0');
            const owing = BigInt(balance?.owingMinor ?? '0');
            return (
              <button
                className="person-card"
                key={friend.id}
                onClick={() => onSelectPerson(friend)}
              >
                <Avatar name={friend.name} size="xl" />
                <h2>{friend.name}</h2>
                <span className="friend-balances">
                  {owed > 0n && <span>{money(owed)} coming your way</span>}
                  {owing > 0n && <span>You owe {money(owing)}</span>}
                  {owed === 0n && owing === 0n && <span>All square</span>}
                </span>
                <span className="person-card-action">
                  Your shared moments <ArrowRight size={15} />
                </span>
              </button>
            );
          })}
      </div>
      <p className="page-note">
        These are your demo friends. Personal contacts will arrive with verified signup.
      </p>
    </>
  );
}
