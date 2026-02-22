//
// theme.js — Dark/Light Theme Manager
//

// Default theme
if (!localStorage.getItem("theme")) {
    localStorage.setItem("theme", "light");
}

function applyTheme(theme) {
    if (theme === "dark") {
        document.documentElement.classList.add("dark");
    } else {
        document.documentElement.classList.remove("dark");
    }
}

// Apply saved theme on load
applyTheme(localStorage.getItem("theme"));

// Toggle function
window.toggleTheme = function () {
    let current = localStorage.getItem("theme");
    let next = current === "light" ? "dark" : "light";
    localStorage.setItem("theme", next);
    applyTheme(next);
};