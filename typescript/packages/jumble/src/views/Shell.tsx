// This is all you need to import/register the @commontools/ui web components
import "@commontools/ui";

const handleClick = () => {
  console.log("clicked");
};

export default function Shell() {
  return (
    <div className="h-full relative">
      {/* You still use class="foo" with web components. */}
      <common-button class="wat" onClick={handleClick}>
        click me
      </common-button>
    </div>
  );
}
