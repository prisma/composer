# Deferred

- S10: an object field with a `field()` leaf (for example `input.smtp` with a wrapped `user`) does not compile as a service binding, because `Pointer<string>` is not accepted as `InputBindingData`. Pre-existing. Closed in S10: `InputBinding<T>` maps the field's type, and `field.test-d.ts` passes `input.smtp` into a service's binding in both libraries.
- S10: check the docs' claim that a field may be a whole service binding (`input: input.smtp`) once service bindings are typed from schemas. Closed in S10: the claim holds; type test 7 of the S10 spec compiles it, and runtime tests 9 and 12 show Load and the serializer handle it.
- S10: a service binding of the whole input fails to compile with "ServiceNode is not assignable to ModuleNode" instead of the message. Closed in S10: the last `provision()` overload is generic over services and modules, so the error shows the message (§ 8 of the S10 spec).
- Later: a service or module that declares both dependencies and an input schema, provisioned with `deps` but without `input`, compiles, because the overload kept for generic wrappers takes `input` as optional. Load refuses it. Pre-existing; found in S10.
- Later: `module()` does not refuse an input schema whose output is not an object. Refusing it would be a new constraint the design does not ask for.
