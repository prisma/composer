# Deferred

- S10: an object field with a `field()` leaf (for example `input.smtp` with a wrapped `user`) does not compile as a service binding, because `Pointer<string>` is not accepted as `InputBindingData`. Pre-existing.
- S10: check the docs' claim that a field may be a whole service binding (`input: input.smtp`) once service bindings are typed from schemas.
- S10: a service binding of the whole input fails to compile with "ServiceNode is not assignable to ModuleNode" instead of the message.
- Later: `module()` does not refuse an input schema whose output is not an object. Refusing it would be a new constraint the design does not ask for.
