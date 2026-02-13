import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

function App() {
  // useQuery: subscribes to real-time updates; re-renders when data changes
  const todos = useQuery(api.todos.list);

  // useMutation: returns a function to invoke; runs once per call
  const addTodo = useMutation(api.todos.add);
  const toggleTodo = useMutation(api.todos.toggle);
  const removeTodo = useMutation(api.todos.remove);

  // useAction: for side effects (HTTP, etc.); not reactive
  const greet = useAction(api.todos.greet);

  const [text, setText] = useState("");
  const [greeting, setGreeting] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await addTodo({ text: text.trim() });
    setText("");
  };

  const handleGreet = async () => {
    const result = await greet({ name: "World" });
    setGreeting(result);
  };

  if (todos === undefined) return <div>Loading...</div>;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Convex Todos</h1>

      <form onSubmit={handleAdd}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="New todo"
          style={{ marginRight: 8, padding: 8 }}
        />
        <button type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
        {todos.map((todo) => (
          <li key={todo._id} style={{ marginBottom: 8, display: "flex", gap: 8 }}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo({ id: todo._id })}
            />
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.text}
            </span>
            <button onClick={() => removeTodo({ id: todo._id })}>Delete</button>
          </li>
        ))}
      </ul>

      <hr style={{ margin: "24px 0" }} />
      <button onClick={handleGreet}>Run action</button>
      {greeting && <p>{greeting}</p>}
    </main>
  );
}

export default App;
import { useQuery, useMutation, useAction } from "convex/react";
import { api } from "../convex/_generated/api";
import { useState } from "react";

function App() {
  // useQuery: subscribes to real-time updates; re-renders when data changes
  const todos = useQuery(api.todos.list);

  // useMutation: returns a function to invoke; runs once per call
  const addTodo = useMutation(api.todos.add);
  const toggleTodo = useMutation(api.todos.toggle);
  const removeTodo = useMutation(api.todos.remove);

  // useAction: for side effects (HTTP, etc.); not reactive
  const greet = useAction(api.todos.greet);

  const [text, setText] = useState("");
  const [greeting, setGreeting] = useState("");

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    await addTodo({ text: text.trim() });
    setText("");
  };

  const handleGreet = async () => {
    const result = await greet({ name: "World" });
    setGreeting(result);
  };

  if (todos === undefined) return <div>Loading...</div>;

  return (
    <main style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Convex Todos</h1>

      <form onSubmit={handleAdd}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="New todo"
          style={{ marginRight: 8, padding: 8 }}
        />
        <button type="submit">Add</button>
      </form>

      <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
        {todos.map((todo) => (
          <li key={todo._id} style={{ marginBottom: 8, display: "flex", gap: 8 }}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => toggleTodo({ id: todo._id })}
            />
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.text}
            </span>
            <button onClick={() => removeTodo({ id: todo._id })}>Delete</button>
          </li>
        ))}
      </ul>

      <hr style={{ margin: "24px 0" }} />
      <button onClick={handleGreet}>Run action</button>
      {greeting && <p>{greeting}</p>}
    </main>
  );
}

export default App;
