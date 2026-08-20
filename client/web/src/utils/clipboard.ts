/**
 * Copy text in browsers where the Clipboard API is unavailable (for example,
 * an HTTP deployment) or rejects because of permissions.
 */
export async function copyTextToClipboard(value: string): Promise<void> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(value);
			return;
		} catch {
			// Fall through to the legacy browser API.
		}
	}

	if (typeof document === "undefined") {
		throw new Error("Clipboard is unavailable outside a browser");
	}

	const textarea = document.createElement("textarea");
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.setAttribute("aria-hidden", "true");
	textarea.style.position = "fixed";
	textarea.style.top = "0";
	textarea.style.left = "-9999px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);
	textarea.focus();
	textarea.select();
	textarea.setSelectionRange(0, textarea.value.length);

	try {
		if (!document.execCommand("copy")) throw new Error("Copy command failed");
	} finally {
		textarea.remove();
	}
}
