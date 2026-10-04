// Faqe publike: çfarë ndodh me mesazhet. Linkohet nga faqja e regjistrimit dhe nga
// materialet e pilotit. Teksti përshkruan atë që bën realisht kodi — përditësoje nëse
// ndryshon një shërbim.
export const metadata = { title: 'Privacy — SupportBot' };

export default function PrivacyPage() {
  return (
    <main className="page">
      <h1>How SupportBot handles data</h1>
      <p className="muted">Last updated: 4 October 2026. Shqip më poshtë.</p>

      <section className="section">
        <h2>What we store</h2>
        <p>
          Messages that visitors send through the chat widget or Telegram, the replies, the documents a business adds
          to its knowledge, and the business owner’s email address. For Telegram we also store the chat ID and the
          first and last name shown on the profile. Website visitors are anonymous: the widget keeps a random
          conversation token in the browser and no cookies.
        </p>
        <h2>Who processes it</h2>
        <p>
          Supabase stores the database. Vercel runs the application. Anthropic receives the conversation and matching
          knowledge excerpts to write a reply. Voyage AI receives document text and questions to index and search
          them. Langfuse receives prompts and replies so we can diagnose wrong answers. Telegram delivers messages
          for businesses that connect a bot.
        </p>
        <h2>What we do not do</h2>
        <p>
          We do not sell data, show ads, or use one business’s conversations or documents to answer another
          business’s customers. Each business can only read its own data.
        </p>
        <h2>Deletion</h2>
        <p>
          A business can delete its documents at any time in the panel. To delete an account, its conversations, or a
          single customer’s messages, write to the contact address of the business or of SupportBot.
        </p>
      </section>

      <section className="section" lang="sq">
        <h2>Çfarë ruajmë</h2>
        <p>
          Mesazhet që vizitorët dërgojnë përmes widget-it ose Telegramit, përgjigjet, dokumentet që biznesi shton te
          njohuritë dhe email-in e pronarit. Për Telegramin ruajmë edhe ID-në e bisedës dhe emrin e profilit.
          Vizitorët e faqes janë anonimë: widget-i mban në shfletues vetëm një kod të rastësishëm bisede, pa cookies.
        </p>
        <h2>Kush i përpunon</h2>
        <p>
          Supabase mban databazën. Vercel ekzekuton aplikacionin. Anthropic merr bisedën dhe pjesët përkatëse të
          njohurive për të shkruar përgjigjen. Voyage AI merr tekstin e dokumenteve dhe pyetjet për t’i indeksuar e
          kërkuar. Langfuse merr pyetjet dhe përgjigjet që të diagnostikojmë përgjigjet e gabuara. Telegram dërgon
          mesazhet për bizneset që lidhin një bot.
        </p>
        <h2>Çfarë nuk bëjmë</h2>
        <p>
          Nuk shesim të dhëna, nuk shfaqim reklama dhe nuk përdorim bisedat ose dokumentet e një biznesi për t’iu
          përgjigjur klientëve të një biznesi tjetër. Çdo biznes lexon vetëm të dhënat e veta.
        </p>
        <h2>Fshirja</h2>
        <p>
          Biznesi mund t’i fshijë dokumentet në çdo kohë nga paneli. Për fshirjen e një llogarie, të bisedave të saj
          ose të mesazheve të një klienti, shkruaj në adresën e kontaktit të biznesit ose të SupportBot.
        </p>
      </section>
    </main>
  );
}
