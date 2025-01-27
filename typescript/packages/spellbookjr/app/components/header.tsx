import Image from "next/image";
import Link from "next/link";
export default function Header() {
  return (
    <header className="bg-purple-50">
      <div className="container mx-auto flex items-center justify-center px-4 py-4 text-center">
        <Link href="/" className="flex items-center space-x-2 justify-center">
          <img
            src="/spellbookjr/images/logo.svg"
            alt="Spellbook Logo"
            className="w-40"
          />
        </Link>
      </div>
    </header>
  );
}
