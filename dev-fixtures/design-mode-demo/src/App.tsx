export function App() {
  return (
    <div className="mx-auto mt-16 max-w-md space-y-6 p-8">
      <h1 className="text-2xl font-bold text-gray-900">Design Mode Demo</h1>
      <p className="text-sm text-gray-500">
        Open this page in the Aegis browser panel, toggle design mode, click an
        element, tweak styles, and Apply.
      </p>
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-gray-800">Card title</h2>
        <p className="mt-2 text-sm text-gray-600">Card body copy for testing.</p>
        <button className="mt-4 rounded-md bg-blue-500 px-4 py-2 text-white">
          Primary action
        </button>
      </div>
    </div>
  );
}
