import { Greeting } from "./Greeting";

export const selfClosing: JSX.Element = <Greeting name="Ada" />;

export const withChildren: JSX.Element = (
  <Greeting name="Grace" excited={true}>
    {null}
  </Greeting>
);
