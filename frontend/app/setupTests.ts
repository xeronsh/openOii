import "@testing-library/jest-dom";

// jsdom exposes requestSubmit() as a not-implemented stub in some versions.
// Override it deterministically so form-oriented tests stay warning-clean
// without changing production component behavior.
Object.defineProperty(HTMLFormElement.prototype, "requestSubmit", {
	configurable: true,
	value(this: HTMLFormElement, submitter?: HTMLElement) {
		if (submitter) {
			submitter.click();
			return;
		}
		this.dispatchEvent(
			new SubmitEvent("submit", { bubbles: true, cancelable: true }),
		);
	},
});
