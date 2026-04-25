export interface GreetingProps {
  name: string;
  excited?: boolean;
}

export function Greeting(props: GreetingProps): JSX.Element {
  return React.createElement("div", null, props.name);
}

export interface UnusedProps {
  marker: true;
}
