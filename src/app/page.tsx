import { redirect } from 'next/navigation';

// Faqja e marketingut jeton në WordPress; ky domen është vetëm paneli + API.
export default function Home() {
  redirect('/app/inbox');
}
